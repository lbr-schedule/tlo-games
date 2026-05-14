// T-LO 德州撲克伺服器
const express = require('express');
const router = express.Router();

// 德州撲克資料庫
const POKER_DB_URL = process.env.POKER_DATABASE_URL || 'libsql://lbr-poker-lbr-schedule.aws-ap-northeast-1.turso.io';
const POKER_DB_AUTH = process.env.POKER_DATABASE_AUTH_TOKEN || '';

// 等級制度
const LEVEL_THRESHOLDS = [
    { level: 1, title: '菜鳥', tier: '青銅' },
    { level: 11, title: '新手', tier: '白銀' },
    { level: 21, title: '老手', tier: '黃金' },
    { level: 31, title: '大師', tier: '白金' },
    { level: 41, title: '傳說', tier: '鑽石' },
];

// 獲取玩家等級
function getPlayerLevel(score) {
    let level = 1;
    for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
        if (score >= LEVEL_THRESHOLDS[i].level * 1000) {
            level = LEVEL_THRESHOLDS[i].level + Math.floor((score - LEVEL_THRESHOLDS[i].level * 1000) / 5000);
            break;
        }
    }
    return Math.min(level, 50);
}

function getPlayerTitle(level) {
    for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
        if (level >= LEVEL_THRESHOLDS[i].level) {
            return LEVEL_THRESHOLDS[i].title;
        }
    }
    return '菜鳥';
}

function getPlayerTier(level) {
    for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
        if (level >= LEVEL_THRESHOLDS[i].level) {
            return LEVEL_THRESHOLDS[i].tier;
        }
    }
    return '青銅';
}

// 初始化資料庫
async function initPokerDb(client) {
    await client.execute(`
        CREATE TABLE IF NOT EXISTS poker_users (
            username TEXT PRIMARY KEY,
            password TEXT NOT NULL,
            score INTEGER DEFAULT 10000,
            games_played INTEGER DEFAULT 0,
            games_won INTEGER DEFAULT 0,
            games_tied INTEGER DEFAULT 0,
            total_bet INTEGER DEFAULT 0,
            total_won INTEGER DEFAULT 0,
            last_login TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await client.execute(`
        CREATE TABLE IF NOT EXISTS poker_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            result TEXT NOT NULL,
            pot INTEGER NOT NULL,
            hand_name TEXT,
            opponent TEXT,
            time TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (username) REFERENCES poker_users(username)
        )
    `);
    await client.execute(`
        CREATE TABLE IF NOT EXISTS poker_daily_bonus (
            username TEXT PRIMARY KEY,
            last_claim TEXT,
            streak INTEGER DEFAULT 0,
            FOREIGN KEY (username) REFERENCES poker_users(username)
        )
    `);
}

// ============ 認證 ============

router.post('/register', async (req, res) => {
    try {
        const { username, password, invitedBy } = req.body;
        if (!username || !password) {
            return res.json({ success: false, message: '請填寫帳號和密碼' });
        }
        if (username.length < 3 || username.length > 20) {
            return res.json({ success: false, message: '帳號需要 3-20 字' });
        }
        if (password.length < 4) {
            return res.json({ success: false, message: '密碼需要至少 4 字' });
        }
        
        // 檢查是否已存在
        const existing = await req.app.locals.pokerDb.execute(
            'SELECT username FROM poker_users WHERE username = ?',
            [username]
        );
        if (existing.rows.length > 0) {
            return res.json({ success: false, message: '帳號已存在' });
        }
        
        // 註冊
        await req.app.locals.pokerDb.execute(
            'INSERT INTO poker_users (username, password, score) VALUES (?, ?, 10000)',
            [username, password]
        );
        
        // 邀請人獎勵
        if (invitedBy) {
            const inviter = await req.app.locals.pokerDb.execute(
                'SELECT score FROM poker_users WHERE username = ?',
                [invitedBy
            ]);
            if (inviter.rows.length > 0) {
                await req.app.locals.pokerDb.execute(
                    'UPDATE poker_users SET score = score + 500 WHERE username = ?',
                    [invitedBy]
                );
            }
        }
        
        res.json({ success: true, message: '註冊成功！獲得 10,000 遊戲金' });
    } catch (e) {
        res.json({ success: false, message: '註冊失敗: ' + e.message });
    }
});

router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const result = await req.app.locals.pokerDb.execute(
            'SELECT username, score, games_played, games_won, games_tied FROM poker_users WHERE username = ? AND password = ?',
            [username, password]
        );
        if (result.rows.length === 0) {
            return res.json({ success: false, message: '帳號或密碼錯誤' });
        }
        
        const user = result.rows[0];
        const level = getPlayerLevel(user.score);
        
        res.json({ 
            success: true, 
            username: user.username,
            score: user.score,
            level,
            title: getPlayerTitle(level),
            tier: getPlayerTier(level),
            games_played: user.games_played,
            games_won: user.games_won,
            games_tied: user.games_tied
        });
    } catch (e) {
        res.json({ success: false, message: '登入失敗: ' + e.message });
    }
});

// ============ 排行榜 ============

router.get('/leaderboard', async (req, res) => {
    try {
        const result = await req.app.locals.pokerDb.execute(
            'SELECT username, score, games_won FROM poker_users ORDER BY score DESC LIMIT 20'
        );
        
        const leaderboard = result.rows.map((row, idx) => {
            const level = getPlayerLevel(row.score);
            return {
                rank: idx + 1,
                username: row.username,
                score: row.score,
                level,
                title: getPlayerTitle(level),
                tier: getPlayerTier(level),
                wins: row.games_won
            };
        });
        
        res.json({ success: true, leaderboard });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// ============ 歷史紀錄 ============

router.get('/history/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const result = await req.app.locals.pokerDb.execute(
            'SELECT result, pot, hand_name, opponent, time FROM poker_history WHERE username = ? ORDER BY id DESC LIMIT 50',
            [username]
        );
        res.json({ success: true, history: result.rows });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// ============ 玩家專區 ============

router.get('/player/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const result = await req.app.locals.pokerDb.execute(
            'SELECT username, score, games_played, games_won, games_tied, total_bet, total_won, last_login, created_at FROM poker_users WHERE username = ?',
            [username]
        );
        if (result.rows.length === 0) {
            return res.json({ success: false, message: '玩家不存在' });
        }
        
        const user = result.rows[0];
        const level = getPlayerLevel(user.score);
        
        res.json({
            success: true,
            player: {
                username: user.username,
                score: user.score,
                level,
                title: getPlayerTitle(level),
                tier: getPlayerTier(level),
                games_played: user.games_played,
                games_won: user.games_won,
                games_tied: user.games_tied,
                win_rate: user.games_played > 0 ? Math.round(user.games_won / user.games_played * 100) : 0,
                total_bet: user.total_bet,
                total_won: user.total_won,
                member_since: user.created_at
            }
        });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// ============ 更新分數 ============

router.post('/update-score', async (req, res) => {
    try {
        const { username, score_change, result, pot, hand_name, opponent } = req.body;
        
        // 更新分數
        await req.app.locals.pokerDb.execute(
            'UPDATE poker_users SET score = score + ?, games_played = games_played + 1 WHERE username = ?',
            [score_change, username]
        );
        
        // 更新勝負
        if (result === 'win') {
            await req.app.locals.pokerDb.execute(
                'UPDATE poker_users SET games_won = games_won + 1, total_won = total_won + ? WHERE username = ?',
                [pot, username]
            );
        } else if (result === 'tie') {
            await req.app.locals.pokerDb.execute(
                'UPDATE poker_users SET games_tied = games_tied + 1 WHERE username = ?',
                [username]
            );
        }
        
        // 記錄歷史
        await req.app.locals.pokerDb.execute(
            'INSERT INTO poker_history (username, result, pot, hand_name, opponent) VALUES (?, ?, ?, ?, ?)',
            [username, result, pot, hand_name || '無', opponent || '電腦']
        );
        
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// ============ 每日獎勵 ============

router.post('/daily-bonus', async (req, res) => {
    try {
        const { username } = req.body;
        const now = new Date().toISOString();
        const today = now.split('T')[0];
        
        const bonus_result = await req.app.locals.pokerDb.execute(
            'SELECT last_claim, streak FROM poker_daily_bonus WHERE username = ?',
            [username]
        );
        
        let bonus = 1000;
        let newStreak = 1;
        
        if (bonus_result.rows.length > 0) {
            const lastClaim = bonus_result.rows[0].last_claim;
            if (lastClaim && lastClaim.startsWith(today)) {
                return res.json({ success: false, message: '今日已領取！明天再來' });
            }
            
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayStr = yesterday.toISOString().split('T')[0];
            
            if (lastClaim && lastClaim.startsWith(yesterdayStr)) {
                newStreak = bonus_result.rows[0].streak + 1;
                bonus = Math.min(1000 + (newStreak - 1) * 200, 5000);
            }
        }
        
        await req.app.locals.pokerDb.execute(
            'INSERT OR REPLACE INTO poker_daily_bonus (username, last_claim, streak) VALUES (?, ?, ?)',
            [username, now, newStreak]
        );
        await req.app.locals.pokerDb.execute(
            'UPDATE poker_users SET score = score + ? WHERE username = ?',
            [bonus, username]
        );
        
        res.json({ success: true, bonus, streak: newStreak, message: `連續登入 ${newStreak} 天！獲得 ${bonus} 金幣` });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// ============ 修改密碼 ============

router.post('/change-password', async (req, res) => {
    try {
        const { username, old_password, new_password } = req.body;
        const result = await req.app.locals.pokerDb.execute(
            'SELECT password FROM poker_users WHERE username = ?',
            [username]
        );
        
        if (result.rows.length === 0 || result.rows[0].password !== old_password) {
            return res.json({ success: false, message: '舊密碼錯誤' });
        }
        
        await req.app.locals.pokerDb.execute(
            'UPDATE poker_users SET password = ? WHERE username = ?',
            [new_password, username]
        );
        
        res.json({ success: true, message: '密碼修改成功' });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

module.exports = router;