// T-LO 德州撲克伺服器
const express = require('express');

// 取得 GMT+8 時間字串（格式：2026/05/19 下午06:37:23）
function getTwTime() {
    const d = new Date(Date.now() + 8*60*60*1000);
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    const da = String(d.getUTCDate()).padStart(2, '0');
    const h = d.getUTCHours();
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    const s = String(d.getUTCSeconds()).padStart(2, '0');
    const ampm = (h >= 4 && h < 16) ? '下午' : '上午';
    const h12 = (h === 0 || h === 12) ? 12 : (h > 12 ? h - 12 : h);
    return y + '/' + mo + '/' + da + ' ' + ampm + String(h12).padStart(2,'0') + ':' + mi + ':' + s;
}

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
            phone TEXT DEFAULT '',
            email TEXT DEFAULT '',
            invite_code TEXT DEFAULT '',
            used_invite_code TEXT DEFAULT '',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Add phone/email columns if they don't exist (for existing databases)
    try {
        await client.execute('ALTER TABLE poker_users ADD COLUMN phone TEXT DEFAULT ""');
    } catch(e) {}
    try {
        await client.execute('ALTER TABLE poker_users ADD COLUMN email TEXT DEFAULT ""');
    } catch(e) {}
    try {
        await client.execute('ALTER TABLE poker_users ADD COLUMN invite_code TEXT DEFAULT ""');
    } catch(e) {}
    try {
        await client.execute("ALTER TABLE poker_users ADD COLUMN last_daily_login TEXT DEFAULT ''");
    } catch(e) {}
    try {
        await client.execute("ALTER TABLE poker_users ADD COLUMN last_invite_reward_claimed TEXT DEFAULT ''");
    } catch(e) {}
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
            last_daily_500 TEXT DEFAULT '',
            streak INTEGER DEFAULT 0,
            FOREIGN KEY (username) REFERENCES poker_users(username)
        )
    `);
    
    await client.execute(`
        CREATE TABLE IF NOT EXISTS poker_invites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inviter TEXT NOT NULL,
            invited TEXT NOT NULL,
            reward INTEGER DEFAULT 200,
            time TEXT DEFAULT CURRENT_TIMESTAMP,
            claimed INTEGER DEFAULT 0,
            FOREIGN KEY (inviter) REFERENCES poker_users(username),
            FOREIGN KEY (invited) REFERENCES poker_users(username)
        )
    `);
    
    await client.execute(`
        CREATE TABLE IF NOT EXISTS poker_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            message TEXT NOT NULL,
            time TEXT DEFAULT CURRENT_TIMESTAMP,
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
        const { username, password, phone, email, invitedBy } = req.body;
        if (!username || !password) {
            return res.json({ success: false, message: '請填寫帳號和密碼' });
        }
        if (username.length < 3 || username.length > 20) {
            return res.json({ success: false, message: '帳號需要 3-20 字' });
        }
        if (password.length < 4) {
            return res.json({ success: false, message: '密碼需要至少 4 字' });
        }
        
        // 驗證手機號碼格式（台灣）
        if (phone) {
            const phoneRegex = /^09[0-9]{8}$/;
            if (!phoneRegex.test(phone)) {
                return res.json({ success: false, message: '手機號碼格式錯誤（需為09開頭的10位數）' });
            }
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
        // Generate invite code (use username as the invite code)
        await req.app.locals.pokerDb.execute(
            'INSERT INTO poker_users (username, password, score) VALUES (?, ?, 1000)',
            [username, password]
        );
        // Update optional fields one by one to avoid missing column errors
        try { await req.app.locals.pokerDb.execute('UPDATE poker_users SET phone = ? WHERE username = ?', [phone || '', username]); } catch(e) {}
        try { await req.app.locals.pokerDb.execute('UPDATE poker_users SET email = ? WHERE username = ?', [email || '', username]); } catch(e) {}
        try { await req.app.locals.pokerDb.execute('UPDATE poker_users SET invite_code = ? WHERE username = ?', [username, username]); } catch(e) {}
        
        // 記錄被使用的邀請碼（新用戶獲得bonus）
        if (invitedBy) {
            try { await req.app.locals.pokerDb.execute('UPDATE poker_users SET used_invite_code = ? WHERE username = ?', [invitedBy, username]); } catch(e) {}
        }
        
        // 邀請人獎勵（不限次數，每次邀請成功可得 200 金幣）
        if (invitedBy) {
            const inviter = await req.app.locals.pokerDb.execute(
                'SELECT score FROM poker_users WHERE username = ?',
                [invitedBy]
            );
            if (inviter.rows.length > 0) {
                await req.app.locals.pokerDb.execute(
                    'UPDATE poker_users SET score = score + 200 WHERE username = ?',
                    [invitedBy]
                );
                // 記錄邀請（不限次數）
                await req.app.locals.pokerDb.execute(
                    'INSERT INTO poker_invites (inviter, invited, reward, claimed) VALUES (?, ?, ?, 0)',
                    [invitedBy, username, 200]
                );
            }
            // 新用戶使用邀請碼註冊，額外獲得 200 金幣
            await req.app.locals.pokerDb.execute(
                'UPDATE poker_users SET score = score + 200 WHERE username = ?',
                [username]
            );
        }
        
        res.json({ success: true, message: '註冊成功！獲得 1,000 遊戲金' + (invitedBy ? '（含邀請獎勵 200 金幣）' : '') });
    } catch (e) {
        res.json({ success: false, message: '註冊失敗: ' + e.message });
    }
});

router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const db = req.app.locals.pokerDb;
        
        // 更新 last_invite_check（這樣舊的邀請通知就會被清除）
        const today = new Date(Date.now() + 8*60*60*1000).toISOString().split('T')[0];
        try {
            await db.execute('UPDATE poker_users SET last_invite_check = ? WHERE username = ?', [today, username]);
        } catch(e) { /* ignore */ }
        
        const result = await db.execute(
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

// ============ 儲存遊戲歷史 ============
router.post('/history', async (req, res) => {
    try {
        const username = getUsernameFromReq(req);
        if (!username) return res.json({ success: false, message: '缺少帳號' });
        const { result, pot, hand_name, opponent } = req.body;
        const db = req.app.locals.pokerDb;
        
        // 使用台灣時區儲存時間
        const twTime = getTwTime();
        
        // 寫入歷史
        await db.execute(
            'INSERT INTO poker_history (username, result, pot, hand_name, opponent, time) VALUES (?, ?, ?, ?, ?, ?)',
            [username, result || 'unknown', pot || 0, hand_name || '普通', opponent || '電腦', twTime]
        );
        
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// ============ 讀取遊戲歷史 ============
router.get('/history/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const result = await req.app.locals.pokerDb.execute(
            'SELECT id, result, pot, hand_name, opponent, time FROM poker_history WHERE username = ? ORDER BY id DESC LIMIT 50',
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
        
        // 檢查是否需要重置每週下注（每週一凌晨，台灣時區）
        const now = new Date();
        const twNow = new Date(now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }));
        const dayOfWeek = twNow.getDay(); // 0=Sun, 1=Mon
        const hours = twNow.getHours();
        // 每週一凌晨00:00-01:00檢查並重置
        if (dayOfWeek === 1 && hours < 1) {
            await req.app.locals.pokerDb.execute(
                'UPDATE poker_player_stats SET weekly_bet = 0 WHERE username = ?',
                [username]
            );
        }
        
        // 更新 poker_users 分數（確保不為負）
        const userResult = await req.app.locals.pokerDb.execute('SELECT score FROM poker_users WHERE username = ?', [username]);
        const currentScore = (userResult.rows && userResult.rows[0] && userResult.rows[0].score) || 0;
        const newScore = Math.max(0, currentScore + score_change);
        await req.app.locals.pokerDb.execute(
            'UPDATE poker_users SET score = ? WHERE username = ?',
            [newScore, username]
        );
        
        // 更新勝負 (前端發來 'player'/'ai'/'tie')
        if (result === 'player') {
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
        
        // 記錄歷史（使用台灣時區）- entry fee 不需要記錄
        if (result !== 'entry') {
            const twTime = getTwTime();
            await req.app.locals.pokerDb.execute(
                'INSERT INTO poker_history (username, result, pot, hand_name, opponent, time) VALUES (?, ?, ?, ?, ?, ?)',
                [username, result, pot, hand_name || '無', opponent || '電腦', twTime]
            );
        }
        
        // 更新每週下注（使用絕對值，不論輸贏）- entry fee 不計入下注統計
        const absBet = Math.abs(score_change);
        const now3 = new Date(Date.now() + 8*60*60*1000);
        const today = now3.toISOString().split('T')[0];
        if (result !== 'entry') {
            await req.app.locals.pokerDb.execute(
                'INSERT INTO poker_player_stats (username, weekly_bet, bet_count_today, wins_today, last_task_reset) VALUES (?, ?, 1, 0, ?) ON CONFLICT(username) DO UPDATE SET weekly_bet = weekly_bet + ?, bet_count_today = bet_count_today + 1, last_task_reset = ?',
                [username, absBet, today, absBet, today]
            );
        }
        
        if (result === 'player') {
            await req.app.locals.pokerDb.execute(
                'UPDATE poker_player_stats SET wins_today = wins_today + 1 WHERE username = ?',
                [username]
            );
        }
        
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// ============ 每日獎勵 ============

router.post('/daily-bonus', async (req, res) => {
    try {
        const { username } = req.body;
        // 使用 UTC+8 標準日期格式
        const now = new Date(Date.now() + 8*60*60*1000);
        const today = now.toISOString().split('T')[0];
        
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
            
            const yesterday = new Date(Date.now() + 8*60*60*1000);
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
                    COALESCE(s.total_win_amount, 0) as total_win_amount, COALESCE(s.total_lose_amount, 0) as total_lose_amount,
                    COALESCE(p.avatar_url, '') as avatar_url, COALESCE(p.birthday, '') as birthday,
                    COALESCE(p.gender, '') as gender, COALESCE(p.personality_tag, '') as personality_tag,
                    COALESCE(p.interest_tag, '') as interest_tag, COALESCE(p.badge_tag, '') as badge_tag,
                    COALESCE(p.mood, '') as mood
             FROM poker_users u
             LEFT JOIN poker_player_stats s ON u.username = s.username
             LEFT JOIN poker_profile p ON u.username = p.username
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
                tier: statsTier,
                avatar_url: user.avatar_url,
                birthday: user.birthday,
                gender: user.gender,
                personality_tag: user.personality_tag,
                interest_tag: user.interest_tag,
                badge_tag: user.badge_tag,
                mood: user.mood
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
    1: 200, 2: 200, 3: 400, 4: 500, 5: 700,
    6: 1000, 7: 2000
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
    // 使用 UTC+8 標準日期格式
    const now = new Date(Date.now() + 8*60*60*1000);
    const today = now.toISOString().split('T')[0];
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
    // 使用 UTC+8 標準日期格式
    const now = new Date(Date.now() + 8*60*60*1000);
    const today = now.toISOString().split('T')[0];
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    
    let newStreak = 1;
    let bonus = STREAK_BONUSES[1] || 100;
    let title = getStreakTitle(1);
    let alreadyClaimed = false;
    
    try {
        const r = await db.execute({ sql: 'SELECT login_streak, last_login_date, last_claim FROM poker_player_stats p LEFT JOIN poker_daily_bonus d ON p.username = d.username WHERE p.username = ?', args: [username] });
        if (r.rows && r.rows.length > 0) {
            const row = r.rows[0];
            // Check if daily bonus was already claimed today using poker_daily_bonus
            if (row.last_claim && row.last_claim.startsWith(today)) {
                alreadyClaimed = true;
            } else {
                if (row.last_login_date === yesterdayStr) {
                    newStreak = (row.login_streak || 0) + 1;
                } else if (row.last_login_date !== today) {
                    newStreak = 1;
                }
                // else: same day login but not yet claimed, keep streak from before
            }
        }
        
        bonus = STREAK_BONUSES[Math.min(newStreak, 7)] || 2000;
        title = getStreakTitle(newStreak);
        
        await db.execute({
            sql: `INSERT INTO poker_player_stats (username, login_streak, last_login_date) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET login_streak = ?, last_login_date = ?`,
            args: [username, newStreak, today, newStreak, today]
        });
        
        // Do NOT update poker_daily_bonus here - only the claim handler should update last_claim
        // This prevents last_claim from being reset when users just check their status
    } catch (e) {
        console.log('processPokerLoginStreak error:', e.message);
    }
    
    return { streak: newStreak, bonus, title, alreadyClaimed };
}

// 從 Authorization header 或 query/body 取得 username
function getUsernameFromReq(req) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
        return auth.slice(7);
    }
    return req.query.username || req.body.username || null;
}

// 取得每日 bonus 狀態
router.get('/daily-bonus', async (req, res) => {
    try {
        const username = getUsernameFromReq(req);
        if (!username) return res.json({ success: false, message: '缺少帳號' });
        
        const db = req.app.locals.pokerDb;
        await checkPokerDailyTasks(db, username);
        const result = await processPokerLoginStreak(db, username);
        
        res.json({
            success: true,
            streak: result.streak,
            reward: result.bonus,
            title: result.title,
            canClaim: !result.alreadyClaimed,
            alreadyClaimed: result.alreadyClaimed
        });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// 領取每日登入獎勵
router.post('/claim-daily-bonus', async (req, res) => {
    try {
        const username = getUsernameFromReq(req);
        if (!username) return res.json({ success: false, message: '缺少帳號' });
        
        const db = req.app.locals.pokerDb;
        await checkPokerDailyTasks(db, username);
        const result = await processPokerLoginStreak(db, username);
        
        if (result.alreadyClaimed) {
            return res.json({ success: false, message: '今天已領取過登入獎勵', streak: result.streak, reward: 0 });
        }
        
        // 發放獎勵
        await db.execute('UPDATE poker_users SET score = score + ? WHERE username = ?', [result.bonus, username]);
        
        // Update last_claim in poker_daily_bonus（使用 UTC+8 標準日期格式）
        const today2 = new Date(Date.now() + 8*60*60*1000).toISOString().split('T')[0];
        // Use INSERT OR REPLACE to ensure row exists and last_claim is properly set
        await db.execute({ sql: 'INSERT OR REPLACE INTO poker_daily_bonus (username, last_claim, streak) VALUES (?, ?, ?)', args: [username, today2, result.streak] });
        
        const r = await db.execute({ sql: 'SELECT score FROM poker_users WHERE username = ?', args: [username] });
        const newScore = (r.rows && r.rows[0] && r.rows[0].score) ? r.rows[0].score : 0;
        
        res.json({
            success: true,
            message: `連續登入 Day ${result.streak}！獲得 $${result.bonus}`,
            streak: result.streak,
            reward: result.bonus,
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
        const username = getUsernameFromReq(req);
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
        const now7 = new Date(Date.now() + 8*60*60*1000);
        const today = now7.toISOString().split('T')[0];
        const todayClaims = completedTasks[today] || [];
        
        const tasks = POKER_DAILY_TASKS.map(t => ({
            id: t.id,
            name: t.name,
            desc: t.desc,
            reward: t.reward,
            progress: t.id.includes('bet') ? (playerStats.bet_count_today || 0) : (playerStats.wins_today || 0),
            target: t.id.includes('bet1') || t.id.includes('win1') ? 1 : 3,
            completed: t.condition(playerStats),
            alreadyClaimed: todayClaims.includes(t.id)
        }));
        
        // 統計資訊
        const stats = {
            betCount: playerStats.bet_count_today || 0,
            winsCount: playerStats.wins_today || 0,
            mysteryBets: playerStats.mystery_bets_today || 0
        };
        
        res.json({
            success: true,
            tasks,
            streak: playerStats.login_streak || 0,
            stats
        });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// 領取任務獎勵
router.post('/claim-task', async (req, res) => {
    try {
        const username = getUsernameFromReq(req);
        const { taskId } = req.body;
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
        
        const now5 = new Date(Date.now() + 8*60*60*1000);
        const today = now5.toISOString().split('T')[0];
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
        const username = getUsernameFromReq(req);
        if (!username) return res.json({ success: false, message: '請先登入' });
        
        const db = req.app.locals.pokerDb;
        // 使用 UTC+8 標準日期格式（與輪盤一致）
        const today = new Date(Date.now() + 8*60*60*1000).toISOString().split('T')[0];
        
        const check = await db.execute({ sql: 'SELECT lastVideoClaim FROM poker_users WHERE username = ?', args: [username] });
        if (check.rows && check.rows.length > 0 && check.rows[0].lastVideoClaim === today) {
            return res.json({ success: false, message: '今天已領過了，明天再來！', alreadyClaimed: true });
        }
        
        await db.execute({ sql: 'UPDATE poker_users SET score = score + 1000, lastVideoClaim = ? WHERE username = ?', args: [today, username] });
        
        const scoreResult = await db.execute({ sql: 'SELECT score FROM poker_users WHERE username = ?', args: [username] });
        const newScore = scoreResult.rows ? scoreResult.rows[0].score : 0;
        
        res.json({ success: true, reward: 1000, amount: 1000, newScore });
    } catch (e) {
        console.error('claim-video error:', e);
        res.json({ success: false, message: '領取失敗，請稍後再試' });
    }
});

// 更新玩家統計（遊戲結束時呼叫）
router.post('/update-stats', async (req, res) => {
    try {
        const { username, bet_amount, won, win_amount, lose_amount } = req.body;
        if (!username) return res.json({ success: false });
        
        const db = req.app.locals.pokerDb;
        const now6 = new Date(Date.now() + 8*60*60*1000);
        const today = now6.toISOString().split('T')[0];
        
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
        { level: 2, title: '菜鳥', tier: '青銅', minBet: 50 },
        { level: 3, title: '新手', tier: '青銅', minBet: 200 },
        { level: 4, title: '新手', tier: '青銅', minBet: 500 },
        { level: 5, title: '新手', tier: '白銀', minBet: 1000 },
        { level: 6, title: '新手', tier: '白銀', minBet: 1500 },
        { level: 7, title: '老手', tier: '白銀', minBet: 2000 },
        { level: 8, title: '老手', tier: '白銀', minBet: 3000 },
        { level: 9, title: '老手', tier: '白銀', minBet: 4000 },
        { level: 10, title: '老手', tier: '黃金', minBet: 5000 },
        { level: 11, title: '老手', tier: '黃金', minBet: 6000 },
        { level: 12, title: '老手', tier: '黃金', minBet: 8000 },
        { level: 13, title: '老手', tier: '黃金', minBet: 10000 },
        { level: 14, title: '老手', tier: '黃金', minBet: 15000 },
        { level: 15, title: '大師', tier: '白金', minBet: 20000 },
        { level: 16, title: '大師', tier: '白金', minBet: 25000 },
        { level: 17, title: '大師', tier: '白金', minBet: 30000 },
        { level: 18, title: '大師', tier: '白金', minBet: 40000 },
        { level: 19, title: '大師', tier: '白金', minBet: 50000 },
        { level: 20, title: '傳說', tier: '白金', minBet: 60000 },
        { level: 21, title: '傳說', tier: '白金', minBet: 75000 },
        { level: 22, title: '傳說', tier: '白金', minBet: 90000 },
        { level: 23, title: '傳說', tier: '白金', minBet: 100000 },
        { level: 24, title: '傳說', tier: '鑽石', minBet: 120000 },
        { level: 25, title: '傳說', tier: '鑽石', minBet: 150000 },
        { level: 30, title: '傳說', tier: '鑽石', minBet: 200000 },
        { level: 35, title: '傳說', tier: '鑽石', minBet: 300000 },
        { level: 40, title: '傳說', tier: '鑽石', minBet: 500000 },
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

// DEBUG: Reset daily tasks for a user
router.post('/admin/reset-tasks', async (req, res) => {
    try {
        const { username } = req.body;
        if (!username) return res.json({ success: false, message: '缺少 username' });
        const db = req.app.locals.pokerDb;
        await db.execute({
            sql: "UPDATE poker_player_stats SET completed_tasks = '{}' WHERE username = ?",
            args: [username]
        });
        res.json({ success: true, message: `已重置 ${username} 的每日任務` });
    } catch(e) {
        res.json({ success: false, message: e.message });
    }
});



// ============ 排行榜 ============
router.get('/leaderboard', async (req, res) => {
    try {
        const db = req.app.locals.pokerDb;
        const result = await db.execute({
            sql: `SELECT username, score FROM poker_users ORDER BY score DESC LIMIT 15`
        });
        const leaderboard = (result.rows || []).map((r, i) => {
            const weeklyBet = r.weekly_bet || 0;
            const levelInfo = getLevelInfo(weeklyBet);
            return { rank: i + 1, username: r.username, score: r.score, ...levelInfo };
        });
        res.json({ success: true, leaderboard });
    } catch(e) {
        console.log('Leaderboard error:', e.message);
        res.json({ success: false, message: '查詢失敗' });
    }
});

// ============ 每日登入獎勵 500（與連續登入無關）============
router.post('/claim-daily-login', async (req, res) => {
    const username = getUsernameFromReq(req);
    if (!username) return res.json({ success: false, message: '缺少帳號' });
    
    const db = req.app.locals.pokerDb;
    if (!db) return res.json({ success: false, message: '資料庫未連線' });
    
    const today = new Date(Date.now() + 8*60*60*1000).toISOString().split('T')[0];
    
    try {
        // 檢查是否已領取（使用 last_daily_500 欄位）
        const check = await db.execute({ sql: 'SELECT last_daily_500 FROM poker_daily_bonus WHERE username = ?', args: [username] });
        if (check.rows && check.rows.length > 0 && check.rows[0].last_daily_500 === today) {
            return res.json({ success: false, message: '今天已領過了，明天再來！', alreadyClaimed: true });
        }
    } catch(e) { console.error('check error:', e.message); }
    
    try {
        // 發放 500 金幣
        await db.execute({ sql: 'UPDATE poker_users SET score = score + 500 WHERE username = ?', args: [username] });
    } catch(e) { 
        console.error('update error:', e.message); 
        return res.json({ success: false, message: '更新失敗: ' + e.message });
    }
    
    // 更新 last_daily_500
    try {
        await db.execute({ sql: 'INSERT OR REPLACE INTO poker_daily_bonus (username, last_daily_500, streak) SELECT ?, ?, COALESCE(streak, 0) FROM poker_daily_bonus WHERE username = ?', args: [username, today, username] });
        // 如果用戶記錄不存在，用另一種方式
        await db.execute({ sql: 'INSERT OR REPLACE INTO poker_daily_bonus (username, last_daily_500) VALUES (?, ?)', args: [username, today] });
    } catch(e) { console.error('bonus update error:', e.message); }
    
    let newScore = 0;
    try {
        const r = await db.execute({ sql: 'SELECT score FROM poker_users WHERE username = ?', args: [username] });
        newScore = (r.rows && r.rows[0] && r.rows[0].score) ? r.rows[0].score : 0;
    } catch(e) { console.error('select error:', e.message); }
    
    console.log('每日登入獎勵 500:', username, 'newScore:', newScore);
    res.json({ success: true, reward: 500, newScore, message: '獲得 500 金幣！' });
});



// ============ 管理員：刪除測試用戶 ============
router.post('/admin/delete-users', async (req, res) => {
    const username = getUsernameFromReq(req);
    if (!username || username !== 'T-LO') return res.json({ success: false, message: '無權限' });
    
    const db = req.app.locals.pokerDb;
    const { users } = req.body; // array of usernames to delete
    
    if (!Array.isArray(users) || users.length === 0) {
        return res.json({ success: false, message: '需提供用戶列表' });
    }
    
    // 保留清單
    const keepList = ['yi1', 'T-LO', 'Sally0126'];
    const toDelete = users.filter(u => !keepList.includes(u));
    
    let deleted = 0;
    for (const u of toDelete) {
        try {
            await db.execute({ sql: 'DELETE FROM poker_users WHERE username = ?', args: [u] });
            await db.execute({ sql: 'DELETE FROM poker_daily_bonus WHERE username = ?', args: [u] });
            await db.execute({ sql: 'DELETE FROM poker_history WHERE username = ?', args: [u] });
            deleted++;
        } catch(e) { console.error('delete error:', u, e.message); }
    }
    
    res.json({ success: true, deleted, remaining: toDelete });
});




// ============ 邀請通知與明細 ============
router.get('/invite-notifications', async (req, res) => {
    const username = getUsernameFromReq(req);
    if (!username) return res.json({ success: false, message: '缺少帳號' });
    
    const db = req.app.locals.pokerDb;
    
    try {
        // Get ALL invites for this inviter (show accumulated earnings)
        const invites = await db.execute(
            'SELECT invited, reward, time FROM poker_invites WHERE inviter = ? AND claimed = 0 ORDER BY time DESC LIMIT 50',
            [username]
        );
        const totalEarned = invites.rows.reduce((sum, r) => sum + (r.reward || 0), 0);
        res.json({ success: true, invites: invites.rows || [], totalEarned, count: invites.rows?.length || 0 });
    } catch(e) { res.json({ success: false, message: e.message }); }
});




// ============ 問題反饋 ============
router.post('/feedback', async (req, res) => {
    const username = getUsernameFromReq(req);
    if (!username) return res.json({ success: false, message: '缺少帳號' });
    
    const { message } = req.body;
    if (!message || message.trim().length === 0) {
        return res.json({ success: false, message: '請輸入內容' });
    }
    
    const db = req.app.locals.pokerDb;
    const today = new Date(Date.now() + 8*60*60*1000).toISOString().split('T')[0];
    
    try {
        await db.execute(
            'INSERT INTO poker_feedback (username, message, time) VALUES (?, ?, ?)',
            [username, message.trim(), today]
        );
        res.json({ success: true, message: '感謝您的回饋！' });
    } catch(e) {
        console.error('Feedback error:', e.message);
        res.json({ success: false, message: '送出失敗，請稍後再試' });
    }
});

// ============ 領取邀請獎勵 ============
router.post('/claim-invite-reward', async (req, res) => {
    const username = getUsernameFromReq(req);
    if (!username) return res.json({ success: false, message: '缺少帳號' });
    
    const db = req.app.locals.pokerDb;
    if (!db) return res.json({ success: false, message: '資料庫未連線' });
    
    try {
        // Get unclaimed invites total (only unclaimed ones)
        const invites = await db.execute('SELECT SUM(reward) as total FROM poker_invites WHERE inviter = ? AND claimed = 0', [username]);
        const totalEarned = (invites.rows && invites.rows[0] && invites.rows[0].total) || 0;
        
        if (totalEarned <= 0) {
            return res.json({ success: false, message: '還沒有可領取的邀請獎勵', alreadyClaimed: true });
        }
        
        // Mark these invites as claimed
        await db.execute('UPDATE poker_invites SET claimed = 1 WHERE inviter = ? AND claimed = 0', [username]);
        
        // Give reward
        await db.execute('UPDATE poker_users SET score = score + ? WHERE username = ?', [totalEarned, username]);
        
        // Get new score
        const newScoreRes = await db.execute('SELECT score FROM poker_users WHERE username = ?', [username]);
        const newScore = (newScoreRes.rows && newScoreRes.rows[0] && newScoreRes.rows[0].score) || 0;
        
        res.json({ success: true, reward: totalEarned, newScore, message: '獲得 ' + totalEarned + ' 金幣！' });
    } catch(e) {
        res.json({ success: false, message: '領取失敗: ' + e.message });
    }
});

module.exports = router;