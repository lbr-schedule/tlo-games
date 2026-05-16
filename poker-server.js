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
            lastVideoClaim TEXT DEFAULT '',
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
            player_cards TEXT,
            ai_cards TEXT,
            community_cards TEXT,
            betting_rounds TEXT,
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
    await client.execute(`
        CREATE TABLE IF NOT EXISTS poker_player_stats (
            username TEXT PRIMARY KEY,
            level INTEGER DEFAULT 1,
            experience INTEGER DEFAULT 0,
            login_streak INTEGER DEFAULT 0,
            streak_title TEXT DEFAULT '',
            weekly_bet INTEGER DEFAULT 0,
            total_bets INTEGER DEFAULT 0,
            total_wins INTEGER DEFAULT 0,
            total_losses INTEGER DEFAULT 0,
            total_win_amount INTEGER DEFAULT 0,
            total_lose_amount INTEGER DEFAULT 0,
            bet_count_today INTEGER DEFAULT 0,
            wins_today INTEGER DEFAULT 0,
            mystery_bets_today INTEGER DEFAULT 0,
            last_task_reset TEXT DEFAULT '',
            last_login_date TEXT DEFAULT '',
            completed_tasks TEXT DEFAULT '{}',
            FOREIGN KEY (username) REFERENCES poker_users(username)
        )
    `);
    await client.execute(`
        CREATE TABLE IF NOT EXISTS poker_profile (
            username TEXT PRIMARY KEY,
            avatar_url TEXT DEFAULT '',
            realname TEXT DEFAULT '',
            phone TEXT DEFAULT '',
            email TEXT DEFAULT '',
            birthday TEXT DEFAULT '',
            gender TEXT DEFAULT '',
            personality_tag TEXT DEFAULT '',
            interest_tag TEXT DEFAULT '',
            badge_tag TEXT DEFAULT '',
            mood TEXT DEFAULT '',
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

// ============ 玩家資料 API ============

// 取得玩家資料（含等級）
router.get('/profile/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const db = req.app.locals.pokerDb;
        
        // 取得玩家基本資料與統計
        const userResult = await db.execute(
            `SELECT u.username, u.score, u.games_played, u.games_won, u.games_tied, u.total_bet, u.total_won, u.created_at,
                    COALESCE(s.level, 1) as level, COALESCE(s.experience, 0) as experience,
                    COALESCE(s.login_streak, 0) as login_streak, COALESCE(s.streak_title, '') as streak_title,
                    COALESCE(s.weekly_bet, 0) as weekly_bet, COALESCE(s.total_bets, 0) as total_bets,
                    COALESCE(s.total_wins, 0) as total_wins, COALESCE(s.total_losses, 0) as total_losses,
                    COALESCE(s.total_win_amount, 0) as total_win_amount, COALESCE(s.total_lose_amount, 0) as total_lose_amount
             FROM poker_users u
             LEFT JOIN poker_player_stats s ON u.username = s.username
             WHERE u.username = ?`,
            [username]
        );
        
        if (userResult.rows.length === 0) {
            return res.json({ success: false, message: '玩家不存在' });
        }
        
        const user = userResult.rows[0];
        const levelInfo = getLevelInfo(user.weekly_bet || 0);
        const statsLevel = levelInfo.level;
        const statsTitle = levelInfo.title;
        const statsTier = levelInfo.tier;
        
        res.json({
            success: true,
            profile: {
                username: user.username,
                score: user.score,
                games_played: user.games_played,
                games_won: user.games_won,
                games_tied: user.games_tied,
                total_bet: user.total_bet,
                total_won: user.total_won,
                member_since: user.created_at,
                level: statsLevel,
                title: statsTitle,
                tier: statsTier
            },
            stats: {
                login_streak: user.login_streak,
                streak_title: user.streak_title,
                weekly_bet: user.weekly_bet,
                total_bets: user.total_bets,
                total_wins: user.total_wins,
                total_losses: user.total_losses,
                total_win_amount: user.total_win_amount,
                total_lose_amount: user.total_lose_amount
            }
        });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// 更新玩家資料
router.put('/profile', async (req, res) => {
    try {
        const { username, avatar_url, birthday, gender, personality_tag, interest_tag, badge_tag, mood } = req.body;
        if (!username) return res.json({ success: false, message: '缺少帳號' });
        
        const db = req.app.locals.pokerDb;
        const fields = [];
        const values = [];
        
        if (avatar_url !== undefined) { fields.push('avatar_url = ?'); values.push(avatar_url); }
        if (birthday !== undefined) { fields.push('birthday = ?'); values.push(birthday); }
        if (gender !== undefined) { fields.push('gender = ?'); values.push(gender); }
        if (personality_tag !== undefined) { fields.push('personality_tag = ?'); values.push(personality_tag); }
        if (interest_tag !== undefined) { fields.push('interest_tag = ?'); values.push(interest_tag); }
        if (badge_tag !== undefined) { fields.push('badge_tag = ?'); values.push(badge_tag); }
        if (mood !== undefined) { fields.push('mood = ?'); values.push(mood); }
        
        if (fields.length > 0) {
            // 確保 poker_profile 資料列存在
            await db.execute(`INSERT OR IGNORE INTO poker_profile (username) VALUES (?)`, [username]);
            values.push(username);
            await db.execute(`UPDATE poker_profile SET ${fields.join(', ')} WHERE username = ?`, values);
        }
        
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// 取得玩家等級資訊
router.get('/player-level/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const db = req.app.locals.pokerDb;
        
        const result = await db.execute(
            `SELECT weekly_bet, level FROM poker_player_stats WHERE username = ?`,
            [username]
        );
        
        if (result.rows && result.rows.length > 0) {
            const weeklyBet = result.rows[0].weekly_bet || 0;
            const levelInfo = getLevelInfo(weeklyBet);
            res.json({ weeklyBet, ...levelInfo });
        } else {
            res.json({ weeklyBet: 0, level: 1, tier: '青銅', title: '菜鳥' });
        }
    } catch (e) {
        res.json({ weeklyBet: 0, level: 1, tier: '青銅', title: '菜鳥' });
    }
});

// ============ 每日登入獎勵 ============

const STREAK_BONUSES = {
    1: 100, 2: 200, 3: 300, 4: 400, 5: 500,
    6: 600, 7: 700, 8: 800, 9: 900, 10: 1000
};

function getStreakTitle(streak) {
    if (streak >= 30) return '🔥 忠實玩家';
    if (streak >= 14) return '⭐ 忠誠粉絲';
    if (streak >= 7) return '💪 活躍玩家';
    if (streak >= 3) return '🌟 新晉玩家';
    return '🌱 初來乍到';
}

// 檢查每日任務重置
async function checkPokerDailyTasks(db, username) {
    const today = new Date().toISOString().split('T')[0];
    try {
        const r = await db.execute({ sql: 'SELECT last_task_reset FROM poker_player_stats WHERE username = ?', args: [username] });
        if (r.rows && r.rows.length > 0 && r.rows[0].last_task_reset === today) return;
        
        await db.execute({
            sql: `INSERT INTO poker_player_stats (username, bet_count_today, wins_today, last_task_reset) VALUES (?, 0, 0, ?) ON CONFLICT(username) DO UPDATE SET bet_count_today = 0, wins_today = 0, last_task_reset = ?`,
            args: [username, today, today]
        });
    } catch (e) { console.log('checkPokerDailyTasks error:', e.message); }
}

// 處理登入連續
async function processPokerLoginStreak(db, username) {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    
    let newStreak = 1;
    let bonus = STREAK_BONUSES[1] || 100;
    let title = getStreakTitle(1);
    let alreadyClaimed = false;
    
    try {
        const r = await db.execute({ sql: 'SELECT login_streak, last_login_date FROM poker_player_stats WHERE username = ?', args: [username] });
        if (r.rows && r.rows.length > 0) {
            const row = r.rows[0];
            if (row.last_login_date === today) {
                alreadyClaimed = true;
            } else {
                if (row.last_login_date === yesterdayStr) {
                    newStreak = (row.login_streak || 0) + 1;
                } else {
                    newStreak = 1;
                }
            }
        }
        
        bonus = STREAK_BONUSES[newStreak] || Math.min(100 + newStreak * 50, 2000);
        title = getStreakTitle(newStreak);
        
        await db.execute({
            sql: `INSERT INTO poker_player_stats (username, login_streak, last_login_date) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET login_streak = ?, last_login_date = ?`,
            args: [username, newStreak, today, newStreak, today]
        });
    } catch (e) {
        console.log('processPokerLoginStreak error:', e.message);
    }
    
    return { streak: newStreak, bonus, title, alreadyClaimed };
}

// 取得每日 bonus 狀態
router.get('/daily-bonus', async (req, res) => {
    try {
        const { username } = req.query;
        if (!username) return res.json({ success: false, message: '缺少帳號' });
        
        const db = req.app.locals.pokerDb;
        await checkPokerDailyTasks(db, username);
        const result = await processPokerLoginStreak(db, username);
        
        if (result.alreadyClaimed) {
            return res.json({ success: false, message: '今天已領取過登入獎勵', streak: result.streak, streakTitle: result.title });
        }
        
        res.json({
            success: true,
            message: `連續登入 Day ${result.streak}！獲得 $${result.bonus}`,
            streak: result.streak,
            bonus: result.bonus,
            title: result.title
        });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// 領取每日登入獎勵
router.post('/claim-daily-bonus', async (req, res) => {
    try {
        const { username } = req.body;
        if (!username) return res.json({ success: false, message: '缺少帳號' });
        
        const db = req.app.locals.pokerDb;
        await checkPokerDailyTasks(db, username);
        const result = await processPokerLoginStreak(db, username);
        
        if (result.alreadyClaimed) {
            return res.json({ success: false, message: '今天已領取過登入獎勵', streak: result.streak, streakTitle: result.title });
        }
        
        // 發放獎勵
        await db.execute('UPDATE poker_users SET score = score + ? WHERE username = ?', [result.bonus, username]);
        
        const r = await db.execute({ sql: 'SELECT score FROM poker_users WHERE username = ?', args: [username] });
        const newScore = r.rows ? r.rows[0].score : 0;
        
        res.json({
            success: true,
            message: `連續登入 Day ${result.streak}！獲得 $${result.bonus}`,
            streak: result.streak,
            bonus: result.bonus,
            title: result.title,
            newScore
        });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// 每日任務
const POKER_DAILY_TASKS = [
    { id: 'task_bet1', name: '完成 1 局撲克', desc: '完成一局遊戲', reward: 50, condition: (stats) => (stats.bet_count_today || 0) >= 1 },
    { id: 'task_bet3', name: '完成 3 局撲克', desc: '完成三局遊戲', reward: 150, condition: (stats) => (stats.bet_count_today || 0) >= 3 },
    { id: 'task_win1', name: '贏得 1 局', desc: '在撲克中取勝一次', reward: 100, condition: (stats) => (stats.wins_today || 0) >= 1 },
    { id: 'task_win3', name: '贏得 3 局', desc: '在撲克中取勝三次', reward: 300, condition: (stats) => (stats.wins_today || 0) >= 3 },
];

// 取得每日任務
router.get('/daily-tasks', async (req, res) => {
    try {
        const { username } = req.query;
        if (!username) return res.json({ success: false, message: '缺少帳號' });
        
        const db = req.app.locals.pokerDb;
        await checkPokerDailyTasks(db, username);
        
        const r = await db.execute({
            sql: 'SELECT bet_count_today, wins_today, login_streak, streak_title, completed_tasks FROM poker_player_stats WHERE username = ?',
            args: [username]
        });
        
        let playerStats = { bet_count_today: 0, wins_today: 0, login_streak: 0, streak_title: '', completed_tasks: '{}' };
        if (r.rows && r.rows.length > 0) {
            playerStats = { ...playerStats, ...r.rows[0] };
        }
        
        let completedTasks = {};
        try { completedTasks = JSON.parse(playerStats.completed_tasks || '{}'); } catch(e) {}
        const today = new Date().toISOString().split('T')[0];
        const todayClaims = completedTasks[today] || [];
        
        const tasks = POKER_DAILY_TASKS.map(t => ({
            ...t,
            completed: t.condition(playerStats),
            alreadyClaimed: todayClaims.includes(t.id)
        }));
        
        res.json({
            success: true,
            tasks,
            streak: playerStats.login_streak || 0,
            streakTitle: playerStats.streak_title || ''
        });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// 領取任務獎勵
router.post('/claim-task', async (req, res) => {
    try {
        const { username, taskId } = req.body;
        if (!username || !taskId) return res.json({ success: false, message: '缺少資料' });
        
        const db = req.app.locals.pokerDb;
        await checkPokerDailyTasks(db, username);
        
        const r = await db.execute({
            sql: 'SELECT bet_count_today, wins_today, completed_tasks FROM poker_player_stats WHERE username = ?',
            args: [username]
        });
        
        let playerStats = { bet_count_today: 0, wins_today: 0, completed_tasks: '{}' };
        if (r.rows && r.rows.length > 0) {
            playerStats = { ...playerStats, ...r.rows[0] };
        }
        
        const today = new Date().toISOString().split('T')[0];
        let completedTasks = {};
        try { completedTasks = JSON.parse(playerStats.completed_tasks || '{}'); } catch(e) {}
        const todayClaims = completedTasks[today] || [];
        
        if (todayClaims.includes(taskId)) {
            return res.json({ success: false, message: '今天已領取過了', alreadyClaimed: true });
        }
        
        const task = POKER_DAILY_TASKS.find(t => t.id === taskId);
        if (!task) return res.json({ success: false, message: '任務不存在' });
        if (!task.condition(playerStats)) return res.json({ success: false, message: '任務尚未完成' });
        
        // 發放獎勵
        await db.execute('UPDATE poker_users SET score = score + ? WHERE username = ?', [task.reward, username]);
        
        // 記錄已領取
        if (!completedTasks[today]) completedTasks[today] = [];
        completedTasks[today].push(taskId);
        await db.execute({
            sql: 'UPDATE poker_player_stats SET completed_tasks = ? WHERE username = ?',
            args: [JSON.stringify(completedTasks), username]
        });
        
        const scoreResult = await db.execute({ sql: 'SELECT score FROM poker_users WHERE username = ?', args: [username] });
        const newScore = scoreResult.rows ? scoreResult.rows[0].score : 0;
        
        res.json({
            success: true,
            message: `完成任務「${task.name}」！獲得 $${task.reward}`,
            reward: task.reward,
            newScore
        });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// 看影片領取獎勵
router.post('/claim-video', async (req, res) => {
    try {
        const { username } = req.body;
        if (!username) return res.json({ success: false, message: '請先登入' });
        
        const db = req.app.locals.pokerDb;
        const today = new Date().toISOString().split('T')[0];
        
        const check = await db.execute({ sql: 'SELECT lastVideoClaim FROM poker_users WHERE username = ?', args: [username] });
        if (check.rows && check.rows.length > 0 && check.rows[0].lastVideoClaim === today) {
            return res.json({ success: false, message: '今天已領過了，明天再來！' });
        }
        
        await db.execute({ sql: 'UPDATE poker_users SET score = score + 1000, lastVideoClaim = ? WHERE username = ?', args: [today, username] });
        
        const scoreResult = await db.execute({ sql: 'SELECT score FROM poker_users WHERE username = ?', args: [username] });
        const newScore = scoreResult.rows ? scoreResult.rows[0].score : 0;
        
        res.json({ success: true, amount: 1000, newScore });
    } catch (e) {
        res.json({ success: false, message: '領取失敗，請稍後再試' });
    }
});

// 更新玩家統計（遊戲結束時呼叫）
router.post('/update-stats', async (req, res) => {
    try {
        const { username, bet_amount, won, win_amount, lose_amount } = req.body;
        if (!username) return res.json({ success: false });
        
        const db = req.app.locals.pokerDb;
        const today = new Date().toISOString().split('T')[0];
        
        // 確保統計資料列存在
        await db.execute(`INSERT OR IGNORE INTO poker_player_stats (username) VALUES (?)`, [username]);
        
        // 更新每週下注量
        await db.execute(
            'UPDATE poker_player_stats SET weekly_bet = weekly_bet + ?, total_bets = total_bets + 1, bet_count_today = bet_count_today + 1 WHERE username = ?',
            [bet_amount || 0, username]
        );
        
        if (won) {
            await db.execute(
                'UPDATE poker_player_stats SET total_wins = total_wins + 1, total_win_amount = total_win_amount + ?, wins_today = wins_today + 1 WHERE username = ?',
                [win_amount || 0, username]
            );
        } else {
            await db.execute(
                'UPDATE poker_player_stats SET total_losses = total_losses + 1, total_lose_amount = total_lose_amount + ? WHERE username = ?',
                [lose_amount || 0, username]
            );
        }
        
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false });
    }
});

// 取得等級門檻資訊（用於前端顯示進度）
function getLevelInfo(weeklyBet) {
    const thresholds = [
        { level: 1, title: '菜鳥', tier: '青銅', minBet: 0 },
        { level: 5, title: '菜鳥', tier: '青銅', minBet: 1000 },
        { level: 11, title: '新手', tier: '白銀', minBet: 5000 },
        { level: 15, title: '新手', tier: '白銀', minBet: 15000 },
        { level: 21, title: '老手', tier: '黃金', minBet: 30000 },
        { level: 25, title: '老手', tier: '黃金', minBet: 50000 },
        { level: 31, title: '大師', tier: '白金', minBet: 100000 },
        { level: 35, title: '大師', tier: '白金', minBet: 200000 },
        { level: 41, title: '傳說', tier: '鑽石', minBet: 500000 },
        { level: 50, title: '傳說', tier: '鑽石', minBet: 1000000 },
    ];
    
    let currentLevel = 1;
    let nextThreshold = thresholds[1];
    let currentThreshold = thresholds[0];
    
    for (let i = thresholds.length - 1; i >= 0; i--) {
        if (weeklyBet >= thresholds[i].minBet) {
            currentLevel = thresholds[i].level;
            currentThreshold = thresholds[i];
            nextThreshold = thresholds[i + 1] || thresholds[i];
            break;
        }
    }
    
    // 計算升級進度
    const currentMin = currentThreshold.minBet;
    const nextMin = nextThreshold.minBet;
    const progress = nextMin > currentMin ? Math.min((weeklyBet - currentMin) / (nextMin - currentMin), 1) : 1;
    
    return {
        level: currentLevel,
        title: currentThreshold.title,
        tier: currentThreshold.tier,
        progress: Math.round(progress * 100),
        currentBet: weeklyBet,
        nextBet: nextMin,
        neededBet: Math.max(0, nextMin - weeklyBet)
    };
}

// 確保模組匯出前的初始化工

// ============ 反饋 ============
router.post('/feedback', async (req, res) => {
    try {
        if (!currentUser) return res.json({ success: false, message: '請先登入' });
        const { feedback } = req.body;
        if (!feedback || feedback.trim().length < 5) {
            return res.json({ success: false, message: '反饋內容至少5個字' });
        }
        // 建立反饋表格（如果不存在）
        await req.app.locals.pokerDb.execute(`
            CREATE TABLE IF NOT EXISTS poker_feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT,
                feedback TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await req.app.locals.pokerDb.execute(
            'INSERT INTO poker_feedback (username, feedback) VALUES (?, ?)',
            [currentUser.username, feedback.trim()]
        );
        res.json({ success: true, message: '送出成功！感謝您的意見！' });
    } catch(e) {
        res.json({ success: false, message: '送出失敗: ' + e.message });
    }
});

module.exports = router;