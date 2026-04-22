const express = require('express');
const http = require('http');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();
const server = http.createServer(app);

// ====== Turso 資料庫 ======
const rouletteDbUrl = process.env.COIN_DATABASE_URL || 'libsql://lbr-coin-lbr-schedule.aws-ap-northeast-1.turso.io';
const rouletteDbAuthToken = process.env.COIN_DATABASE_AUTH_TOKEN || '';
let rouletteDb = null;
let rouletteDbAvailable = false;
const LOCAL_TEST_MODE = !process.env.COIN_DATABASE_URL;

if (LOCAL_TEST_MODE) {
    rouletteDbAvailable = true;
    rouletteDb = { execute: async () => {} };
} else {
    try {
        rouletteDb = createClient({ url: rouletteDbUrl, authToken: rouletteDbAuthToken });
    } catch(e) { console.log('資料庫建立失敗:', e.message); }
}

// ====== 工具函式 ======
function weightedRandom(weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r <= 0) return i;
    }
    return weights.length - 1;
}

// ====== 獎項設定 ======
const REWARDS = [
    { multiplier: 8, weight: 1 },
    { multiplier: 3, weight: 6 },
    { multiplier: 1.5, weight: 18 },
    { multiplier: 1, weight: 20 },
    { multiplier: 0.5, weight: 25 },
    { multiplier: 0, weight: 30 }
];

// ====== 玩家 Session ======
const playerSessions = {};

function getPlayerSession(userId) {
    if (!playerSessions[userId]) {
        playerSessions[userId] = {
            pulls: 0, totalBet: 0, totalWin: 0,
            loseStreak: 0, dailyWin: 0,
            lastReset: new Date().toDateString()
        };
    }
    const session = playerSessions[userId];
    const today = new Date().toDateString();
    if (session.lastReset !== today) {
        session.dailyWin = 0;
        session.lastReset = today;
    }
    return session;
}

function calculateWeights(session, baseWeights) {
    const weights = [...baseWeights];
    const phase = session.pulls < 10 ? 'early' : session.pulls < 25 ? 'mid' : 'late';
    if (phase === 'early') {
        weights[0] *= 3; weights[1] *= 2; weights[2] *= 1.5;
    } else if (phase === 'late') {
        weights[0] /= 3; weights[1] /= 2; weights[2] /= 1.5;
    }
    if (session.loseStreak >= 10) {
        weights[2] = Math.max(weights[2], 50);
        weights[3] = Math.max(weights[3], 20);
    }
    if (session.totalBet > 0) {
        const rtp = session.totalWin / session.totalBet;
        if (rtp > 0.8) { weights[0] /= 2; weights[1] /= 1.5; }
        else if (rtp < 0.6 && session.totalBet > 1000) { weights[0] *= 1.5; weights[1] *= 1.2; }
    }
    if (session.dailyWin > 50000) { weights[0] = 0; weights[1] /= 3; weights[2] /= 2; }
    return weights.map(w => Math.max(w, 0.1));
}

// ====== 廣告設定 ======
const ADS = [
    'https://minimax-algeng-chat-tts-us.oss-us-east-1.aliyuncs.com/ccv2%2F2026-04-20%2FMiniMax-M2.7%2F2042085561899950328%2Fe31bd1d00652ef9c369cd2b3d5c24d10fe48f69af46990b15c3f5f72889d572b..jpeg?Expires=1776743361&OSSAccessKeyId=LTAI5tCpJNKCf5EkQHSuL9xg&Signature=kChSadc08%2Byf41NVI6XQwUQ%2BTko%3D',
    'https://minimax-algeng-chat-tts-us.oss-us-east-1.aliyuncs.com/ccv2%2F2026-04-20%2FMiniMax-M2.7%2F2042085561899950328%2Fa0341b29441c11c1b49b7514a4ea8fa9af655cc2b25a2048a4bcf5ab22e34085..jpeg?Expires=1776779408&OSSAccessKeyId=LTAI5tCpJNKCf5EkQHSuL9xg&Signature=4Gx9rRMpx0vFcSFSHxmK4VTRZ0o%3D',
    'https://minimax-algeng-chat-tts-us.oss-us-east-1.aliyuncs.com/ccv2%2F2026-04-20%2FMiniMax-M2.7%2F2042085561899950328%2F350fd95706f0eb5aef392f05fd99445ae08df872e58bfc779709ffb2a75c9f24..jpeg?Expires=1776780126&OSSAccessKeyId=LTAI5tCpJNKCf5EkQHSuL9xg&Signature=p1kj5rk75RTnrI3npoM9GukX2jU%3D',
    'https://minimax-algeng-chat-tts-us.oss-us-east-1.aliyuncs.com/ccv2%2F2026-04-20%2FMiniMax-M2.7%2F2042085561899950328%2F41db7be8f36a75e27f698c7df2fc38df8278dd34134649679ec7fc3b87a40e67..jpeg?Expires=1776780397&OSSAccessKeyId=LTAI5tCpJNKCf5EkQHSuL9xg&Signature=%2BksrIU57D38%2FtlKWFcI29psNMkk%3D',
    'https://minimax-algeng-chat-tts-us.oss-us-east-1.aliyuncs.com/ccv2%2F2026-04-22%2FMiniMax-M2.7%2F2042085561899950328%2F7efef79fad4fa853d54803b00f59ba398679ff890442413343be9fb93adaab0b..jpeg?Expires=1776905136&OSSAccessKeyId=LTAI5tCpJNKCf5EkQHSuL9xg&Signature=9QXbabqQHI8BUaR54JjmhJ4eDxQ%3D'
];
let lastAdIndex = 0;
const AD_RATE = 0.1;

function getNextAd() {
    lastAdIndex = (lastAdIndex + 1) % ADS.length;
    return { url: ADS[lastAdIndex], lineId: '@778ryayw' };
}

// ====== 初始化資料表 ======
async function initTables() {
    if (LOCAL_TEST_MODE || !rouletteDbAvailable) return;
    try {
        await rouletteDb.execute({ sql: `CREATE TABLE IF NOT EXISTS coin_users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, coin_balance INTEGER DEFAULT 1000, total_bet INTEGER DEFAULT 0, total_win INTEGER DEFAULT 0, realname TEXT, phone TEXT, email TEXT, invited_by TEXT, created_at TEXT)` });
        await rouletteDb.execute({ sql: `CREATE TABLE IF NOT EXISTS coin_spin_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, bet_amount INTEGER, reward INTEGER, multiplier REAL, timestamp TEXT)` });
        await rouletteDb.execute({ sql: `CREATE TABLE IF NOT EXISTS coin_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, feedback TEXT, created_at TEXT)` });
        await rouletteDb.execute({ sql: `CREATE TABLE IF NOT EXISTS coin_leaderboard (username TEXT PRIMARY KEY, coin_balance INTEGER)` });
        console.log('資料表初始化成功');
    } catch(e) { console.log('初始化資料表失敗:', e.message); }
}
initTables();

// ====== 靜態檔案 ======
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ====== API：註冊 ======
app.post('/api/coin/register', async (req, res) => {
    const { username, password, realname, phone, email, inviteCode } = req.body;
    if (!username || !password) return res.json({ success: false, message: '請填寫帳號和密碼' });
    if (!realname || !phone) return res.json({ success: false, message: '請填寫姓名和電話' });
    if (LOCAL_TEST_MODE || !rouletteDbAvailable) {
        return res.json({ success: true, message: '註冊成功！獲得 1000 金幣！' });
    }
    try {
        const check = await rouletteDb.execute({ sql: `SELECT id FROM coin_users WHERE username = ?`, args: [username] });
        if (check.rows && check.rows.length > 0) {
            return res.json({ success: false, message: '帳號已存在' });
        }
        await rouletteDb.execute({ sql: `INSERT INTO coin_users (username, password, coin_balance, realname, phone, email, invited_by) VALUES (?, ?, 1000, ?, ?, ?, ?)`, args: [username, password, realname, phone, email || '', inviteCode || ''] });
        if (inviteCode) {
            await rouletteDb.execute({ sql: `UPDATE coin_users SET coin_balance = coin_balance + 200 WHERE username = ?`, args: [inviteCode] });
            await rouletteDb.execute({ sql: `UPDATE coin_users SET coin_balance = coin_balance + 200 WHERE username = ?`, args: [username] });
        }
        res.json({ success: true, message: '註冊成功！獲得 1000 金幣！' });
    } catch(e) { console.log('註冊失敗:', e.message); res.json({ success: false, message: '註冊失敗' }); }
});

// ====== API：登入 ======
app.post('/api/coin/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, message: '請填寫帳號和密碼' });
    if (LOCAL_TEST_MODE || !rouletteDbAvailable) {
        const session = getPlayerSession(username);
        return res.json({ success: true, player: { username, balance: 1000, total_bet: 0, total_win: 0 } });
    }
    try {
        const result = await rouletteDb.execute({ sql: `SELECT * FROM coin_users WHERE username = ? AND password = ?`, args: [username, password] });
        if (result.rows && result.rows.length > 0) {
            const row = result.rows[0];
            res.json({ success: true, player: { username: row.username, balance: row.coin_balance, total_bet: row.total_bet, total_win: row.total_win } });
        } else {
            res.json({ success: false, message: '帳號或密碼錯誤' });
        }
    } catch(e) { console.log('登入失敗:', e.message); res.json({ success: false, message: '登入失敗' }); }
});

// ====== API：排行榜 ======
app.get('/api/coin/leaderboard', async (req, res) => {
    if (LOCAL_TEST_MODE || !rouletteDbAvailable) return res.json({ success: true, leaderboard: [] });
    try {
        const result = await rouletteDb.execute({ sql: `SELECT username, coin_balance as balance FROM coin_users ORDER BY coin_balance DESC LIMIT 15` });
        res.json({ success: true, leaderboard: result.rows || [] });
    } catch(e) { res.json({ success: false, leaderboard: [] }); }
});

// ====== API：歷史紀錄 ======
app.get('/api/coin/history/:username', async (req, res) => {
    const { username } = req.params;
    if (LOCAL_TEST_MODE || !rouletteDbAvailable) return res.json({ success: true, history: [] });
    try {
        const result = await rouletteDb.execute({ sql: `SELECT * FROM coin_spin_logs WHERE username = ? ORDER BY id DESC LIMIT 50`, args: [username] });
        res.json({ success: true, history: result.rows || [] });
    } catch(e) { res.json({ success: false, history: [] }); }
});

// ====== API：意見反饋 ======
app.post('/api/coin/feedback', async (req, res) => {
    const { username, feedback } = req.body;
    if (!username || !feedback) return res.json({ success: false, message: '參數錯誤' });
    if (LOCAL_TEST_MODE || !rouletteDbAvailable) {
        return res.json({ success: true });
    }
    try {
        await rouletteDb.execute({ sql: `INSERT INTO coin_feedback (username, feedback, created_at) VALUES (?, ?, ?)`, args: [username, feedback, new Date().toISOString()] });
        res.json({ success: true });
    } catch(e) { res.json({ success: false, message: '儲存失敗' }); }
});

// ====== API：擲硬幣（核心遊戲）======
app.post('/api/coin/spin', async (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.json({ error: 'user_id is required' });

    const session = getPlayerSession(user_id);
    const BET = 100;
    session.pulls++;

    const baseWeights = REWARDS.map(r => r.weight);
    const adjustedWeights = calculateWeights(session, baseWeights);
    const rewardIndex = weightedRandom(adjustedWeights);
    const reward = REWARDS[rewardIndex];
    const rewardCoins = Math.floor(BET * reward.multiplier);

    session.totalBet += BET;
    session.totalWin += rewardCoins;
    session.dailyWin += (rewardCoins - BET);
    if (reward.multiplier <= 1) session.loseStreak++;
    else session.loseStreak = 0;

    // 顯示廣告？
    const showAd = Math.random() < AD_RATE;
    const ad = showAd ? getNextAd() : null;

    if (!LOCAL_TEST_MODE && rouletteDbAvailable) {
        try {
            await rouletteDb.execute({ sql: `INSERT INTO coin_spin_logs (username, bet_amount, reward, multiplier, timestamp) VALUES (?, ?, ?, ?, ?)`, args: [user_id, BET, rewardCoins, reward.multiplier, new Date().toISOString()] });
            await rouletteDb.execute({ sql: `UPDATE coin_users SET coin_balance = coin_balance + ?, total_bet = total_bet + ?, total_win = total_win + ? WHERE username = ?`, args: [rewardCoins - BET, BET, rewardCoins, user_id] });
            const bal = await rouletteDb.execute({ sql: `SELECT coin_balance FROM coin_users WHERE username = ?`, args: [user_id] });
            const balance = bal.rows && bal.rows[0] ? bal.rows[0].coin_balance : 1000;
            res.json({ reward_multiplier: reward.multiplier, reward_coins: rewardCoins, updated_balance: balance, lose_streak: session.loseStreak, daily_win: session.dailyWin, ad });
        } catch(e) {
            console.log('儲存失敗:', e.message);
            res.json({ reward_multiplier: reward.multiplier, reward_coins: rewardCoins, updated_balance: 1000 + session.totalWin - session.totalBet, lose_streak: session.loseStreak, daily_win: session.dailyWin, ad });
        }
    } else {
        const balance = 1000 + session.totalWin - session.totalBet;
        res.json({ reward_multiplier: reward.multiplier, reward_coins: rewardCoins, updated_balance: balance, lose_streak: session.loseStreak, daily_win: session.dailyWin, ad });
    }
});

// ====== API：餘額 ======
app.get('/api/coin/balance', async (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.json({ error: 'user_id required' });
    const session = getPlayerSession(user_id);
    const balance = 1000 + session.totalWin - session.totalBet;
    res.json({ user_id, balance, total_bet: session.totalBet, total_win: session.totalWin, pulls: session.pulls, lose_streak: session.loseStreak });
});

const PORT = 3001;
server.listen(PORT, () => {
    console.log('硬幣輪盤伺服器已啟動 http://localhost:' + PORT);
});