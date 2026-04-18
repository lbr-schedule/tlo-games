const express = require('express');
const http = require('http');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();
const server = http.createServer(app);

// 骰子遊戲資料庫（Turso）
const dbUrl = process.env.DATABASE_URL || 'libsql://lbr-dice-lbr-schedule.aws-ap-northeast-1.turso.io';
const dbAuthToken = process.env.DATABASE_AUTH_TOKEN || '';

let db = null;
let dbAvailable = false;

try {
    db = createClient({
        url: dbUrl,
        authToken: dbAuthToken
    });
    dbAvailable = true;
    console.log('骰子遊戲已连接到 Turso 数据库:', dbUrl);
} catch(e) {
    console.log('骰子遊戲 Turso 连接失败:', e.message);
}

// 輪盤遊戲資料庫（Turso）
const rouletteDbUrl = process.env.ROULETTE_DATABASE_URL || 'libsql://lbr-roulette-lbr-schedule.aws-ap-northeast-1.turso.io';
const rouletteDbAuthToken = process.env.ROULETTE_DATABASE_AUTH_TOKEN || '';

let rouletteDb = null;
let rouletteDbAvailable = false;

// 本地測試模式：使用記憶體資料庫
const LOCAL_TEST_MODE = !process.env.ROULETTE_DATABASE_URL;
const localPlayers = {}; // { username: { password, score } }
const localHistory = [];  // [{ username, result, color, win, amount }]

if (LOCAL_TEST_MODE) {
    console.log('⚠️ 本地測試模式：使用記憶體資料庫（所有資料重啟後消失）');
    rouletteDbAvailable = true; // 假設可用，因為使用記憶體模式
} else {
    try {
        rouletteDb = createClient({
            url: rouletteDbUrl,
            authToken: rouletteDbAuthToken
        });
        console.log('輪盤遊戲 Turso client 已建立');
    } catch(e) {
        console.log('輪盤遊戲 Turso client 建立失敗:', e.message);
    }
}

// 測試輪盤資料庫連線
if (rouletteDb && !LOCAL_TEST_MODE) {
    rouletteDb.execute({ sql: 'SELECT 1 as test' }).then((result) => {
        console.log('輪盤資料庫連線測試成功, result:', JSON.stringify(result));
        rouletteDbAvailable = true;
    }).catch(e => {
        console.log('輪盤資料庫連線測試失敗:', e.message);
        rouletteDbAvailable = false;
    });
}

// 骰子遊戲用 HTTP Long-Polling（取代 WebSocket）
const diceState = {
    waitingPlayers: [],
    games: new Map(),
    players: new Map(),  // { username: { lastPoll: timestamp, pendingMessages: [] } }
    pollInterval: 1000    // 1秒polling
};

// 輪盤遊戲狀態（單人，無需 WebSocket）
let rouletteState = {
    phase: 'waiting', // waiting, betting, spinning, result
    result: null,
    lastSpin: null,
    spinTimer: null,
    betTimer: null,
    BETTING_TIME: 8000,
    phaseStartTime: 0,
    hasPlayer: false
};

// ========== 骰子遊戲邏輯 ==========
function createDiceGame(player1, player2) {
    return {
        id: Date.now(),
        players: [player1, player2],
        scores: [0, 0],
        rolled: [false, false],  // 記錄誰已骰
        diceValues: [0, 0],       // 記錄骰出的點數
        status: 'playing',
        round: 1
    };
}

function broadcastDice(msg) {
    // 廣播消息到所有玩家的 pendingMessages（long-polling 機制）
    for (const [name, data] of diceState.players) {
        data.pendingMessages.push(msg);
    }
}

// 發送消息給特定玩家（long-polling 機制）
function sendToPlayer(username, msg) {
    const player = diceState.players.get(username);
    if (player) {
        player.pendingMessages.push(msg);
    }
}


// 骰子遊戲 - 更新玩家積分
// 獲取玩家積分
async function getPlayerScore(username) {
    if (!dbAvailable) return null;
    try {
        const result = await db.execute({
            sql: 'SELECT score FROM players WHERE username = ?',
            args: [username]
        });
        return result.rows?.[0]?.score ?? null;
    } catch(e) {
        return null;
    }
}

async function updateDicePlayerScore(winner, loser, betAmount) {
    if (LOCAL_TEST_MODE) {
        // 本地測試模式
        if (localPlayers[winner]) localPlayers[winner].score += betAmount;
        if (localPlayers[loser]) localPlayers[loser].score = Math.max(0, localPlayers[loser].score - betAmount);
        return;
    }
    
    if (!dbAvailable) return;
    
    try {
        // 贏家加積分
        await db.execute({
            sql: `UPDATE players SET score = score + ? WHERE username = ?`,
            args: [betAmount, winner]
        });
        // 輸家扣積分
        await db.execute({
            sql: `UPDATE players SET score = CASE WHEN score < ? THEN 0 ELSE score - ? END WHERE username = ?`,
            args: [betAmount, betAmount, loser]
        });
        console.log('骰子遊戲積分結算:', winner, '+' + betAmount, loser, '-' + betAmount);
    } catch(e) {
        console.log('更新骰子遊戲積分失敗:', e.message);
    }
}

async function handleDiceMessage(ws, msg) {
    const username = msg.username || 'Player';

    if (msg.type === 'cancel') {
        // Remove from waiting list
        diceState.waitingPlayers = diceState.waitingPlayers.filter(p => p !== username);
        sendToPlayer(username, { type: 'cancel' });
        return;
    }
    
    if (msg.type === 'leave') {
        const player = diceState.players.get(username);
        
        // If in a game, notify opponent and remove game
        if (player?.gameId) {
            const game = diceState.games.get(player.gameId);
            if (game) {
                const opponent = game.players.find(p => p !== username);
                if (opponent) {
                    sendToPlayer(opponent, { type: 'opponent_left' });
                    // Reset opponent's state
                    const oppPlayer = diceState.players.get(opponent);
                    if (oppPlayer) delete oppPlayer.gameId;
                }
                diceState.games.delete(player.gameId);
            }
        }
        
        // Remove from waiting list if there
        diceState.waitingPlayers = diceState.waitingPlayers.filter(p => p !== username);
        delete player.gameId;
        sendToPlayer(username, { type: 'left' });
        return;
    }
    
    if (msg.type === 'join') {
        const player = diceState.players.get(username);
        
        // Check if player has enough score to play (min 10)
        let playerScore = 0;
        try {
            const result = await db.execute({
                sql: 'SELECT score FROM players WHERE username = ?',
                args: [username]
            });
            playerScore = result.rows?.[0]?.score ?? 0;
        } catch(e) {}
        
        if (playerScore < 10) {
            sendToPlayer(username, { type: 'balance_insufficient', score: playerScore, required: 10 });
            return;
        }
        
        // If already in a game, re-send game_start with current game info
        if (player?.gameId) {
            const game = diceState.games.get(player.gameId);
            if (game) {
                const opponent = game.players[1 - game.players.indexOf(username)];
                sendToPlayer(username, { type: 'game_start', opponent: opponent, gameId: player.gameId, myIndex: game.players.indexOf(username) });
                return;
            } else {
                // Game expired or deleted, clear gameId and treat as fresh
                delete player.gameId;
            }
        }
        
        // If already in waiting list, just re-send waiting message
        if (diceState.waitingPlayers.includes(username)) {
            sendToPlayer(username, { type: 'waiting', message: '等待對手中...' });
            return;
        }
        
        // Remove from waiting list (prevent duplicates)
        diceState.waitingPlayers = diceState.waitingPlayers.filter(p => p !== username);
        
        // If there are other waiting players, match immediately (check both have score)
        if (diceState.waitingPlayers.length > 0) {
            // Find a waiting player with enough score
            let opponent = null;
            for (const p of diceState.waitingPlayers) {
                try {
                    const result = await db.execute({
                        sql: 'SELECT score FROM players WHERE username = ?',
                        args: [p]
                    });
                    const score = result.rows?.[0]?.score ?? 0;
                    if (score >= 10) {
                        opponent = diceState.waitingPlayers.shift();
                        break;
                    } else {
                        // Remove player with insufficient score
                        diceState.waitingPlayers = diceState.waitingPlayers.filter(wp => wp !== p);
                    }
                } catch(e) {}
            }
            
            if (!opponent) {
                // No valid opponent, just add self to queue
                diceState.waitingPlayers.push(username);
                sendToPlayer(username, { type: 'waiting', message: '等待對手中...' });
                return;
            }
            const game = createDiceGame(opponent, username);
            diceState.games.set(game.id, game);
            
            // Check both players have enough score before starting
            let opponentScore = 0;
            try {
                const r = await db.execute({ sql: 'SELECT score FROM players WHERE username = ?', args: [opponent] });
                opponentScore = r.rows?.[0]?.score ?? 0;
            } catch(e) {}
            
            if (opponentScore < 10) {
                // Opponent no longer has enough score, notify and remove from queue
                diceState.waitingPlayers = diceState.waitingPlayers.filter(p => p !== opponent);
                sendToPlayer(opponent, { type: 'balance_insufficient', score: opponentScore, required: 10 });
                // Add current player to queue instead
                diceState.waitingPlayers.push(username);
                sendToPlayer(username, { type: 'waiting', message: '等待對手中...' });
                return;
            }
            
            // Send game_start to both
            sendToPlayer(opponent, { type: 'game_start', opponent: username, gameId: game.id, myIndex: 0 });
            sendToPlayer(username, { type: 'game_start', opponent: opponent, gameId: game.id, myIndex: 1 });
            
            // Update player game state
            diceState.players.set(opponent, { ...(diceState.players.get(opponent) || {}), gameId: game.id });
            diceState.players.set(username, { ...(diceState.players.get(username) || {}), gameId: game.id });
        } else {
            // No one waiting, add to queue
            diceState.waitingPlayers.push(username);
            sendToPlayer(username, { type: 'waiting', message: '等待對手中...' });
        }
    }
    
    if (msg.type === 'roll') {
        const player = diceState.players.get(username);
        if (!player?.gameId) return;
        
        const game = diceState.games.get(player.gameId);
        if (!game || game.status !== 'playing') return;
        
        const playerIndex = game.players.indexOf(username);
        // 檢查這玩家是否已經骰過（不重複骰）
        if (game.rolled && game.rolled[playerIndex]) return;
        
        // 如果是老闆帳號(12345)，使用加權骰子給予約70%勝率
        let dice;
        if (username === '12345') {
            // 65%機會骰到5-6，35%機會骰到1-4
            dice = Math.random() < 0.65 ? Math.floor(Math.random() * 2) + 5 : Math.floor(Math.random() * 4) + 1;
        } else {
            dice = Math.floor(Math.random() * 6) + 1;
        }
        // 記錄骰子
        game.rolled[playerIndex] = true;
        game.diceValues[playerIndex] = dice;
        
        // 廣播骰子結果（包含雙方骰子）
        broadcastDice({
            type: 'roll_result',
            player: username,
            dice,
            diceValues: [...game.diceValues],
            rolled: [...game.rolled]
        });
        
        // 檢查是否雙方都骰完
        if (game.rolled[0] && game.rolled[1]) {
            // 計算勝負
            const [d1, d2] = game.diceValues;
            let winner, isDraw;
            if (d1 > d2) { winner = game.players[0]; isDraw = false; }
            else if (d2 > d1) { winner = game.players[1]; isDraw = false; }
            else { winner = null; isDraw = true; }
            
            game.status = 'finished';
            game.winner = winner;
            game.isDraw = isDraw;
            
            broadcastDice({
                type: 'game_over',
                diceValues: [...game.diceValues],
                winner: winner,
                isDraw: isDraw
            });
            
            // 結算後更新資料庫積分
            if (winner && !isDraw) {
                const loser = game.players.find(p => p !== winner);
                updateDicePlayerScore(winner, loser, 10);
                
                // 廣播積分更新給雙方
                getPlayerScore(winner).then(wScore => {
                    getPlayerScore(loser).then(lScore => {
                        if (wScore !== null) {
                            sendToPlayer(winner, { type: 'score_update', score: wScore });
                        }
                        if (lScore !== null) {
                            sendToPlayer(loser, { type: 'score_update', score: lScore });
                        }
                    });
                });
            }
        }
        
        // 一局 = 雙方各擲一次 = 2次roll
        // 2 rolls per round, then end round
        if (game.round >= 3) {
            const winner = game.scores[0] > game.scores[1] ? 0 : (game.scores[1] > game.scores[0] ? 1 : -1);
            game.status = 'finished';
            game.winner = winner >= 0 ? game.players[winner] : null;
            game.isDraw = winner === -1;
            game.rematchRequests = [];
            
            broadcastDice({
                type: 'game_over',
                scores: game.scores,
                winner: game.winner,
                isDraw: game.isDraw
            });
            
            // 非平手時更新積分
            if (game.winner && !game.isDraw) {
                const loser = game.players.find(p => p !== game.winner);
                updateDicePlayerScore(game.winner, loser, 10); // 預設10積分
            }
        }
    }
    
    if (msg.type === 'rematch') {
        const player = diceState.players.get(username);
        if (!player?.gameId) return;
        
        const game = diceState.games.get(player.gameId);
        if (!game || game.status !== 'finished') return;
        
        // 一方按了馬上開始新遊戲
        const newGame = createDiceGame(game.players[0], game.players[1]);
        diceState.games.set(newGame.id, newGame);
        diceState.games.delete(game.id);
        
        // 更新雙方玩家的 gameId
        const p0 = diceState.players.get(game.players[0]);
        const p1 = diceState.players.get(game.players[1]);
        if (p0) p0.gameId = newGame.id;
        if (p1) p1.gameId = newGame.id;
        
        // 發送 game_start 給雙方（包含 myIndex 和 opponent）
        sendToPlayer(game.players[0], { type: 'game_start', opponent: game.players[1], gameId: newGame.id, myIndex: 0 });
        sendToPlayer(game.players[1], { type: 'game_start', opponent: game.players[0], gameId: newGame.id, myIndex: 1 });
    }
}

// JSON 解析
app.use(express.json());

// ========== 骰子遊戲 HTTP Long-Polling 端點 ==========
// 客戶端每1秒輪詢一次 /dice/poll
app.get('/dice/poll', (req, res) => {
    const username = req.query.username;
    if (!username) return res.json({ error: 'no username' });
    
    // 初始化玩家狀態
    if (!diceState.players.has(username)) {
        diceState.players.set(username, { lastPoll: Date.now(), pendingMessages: [] });
    }
    
    const player = diceState.players.get(username);
    player.lastPoll = Date.now();
    
    // 返回所有待發送消息並清空
    const messages = player.pendingMessages;
    player.pendingMessages = [];
    
    res.json({ messages, timestamp: Date.now() });
});


// 清理超時玩家（30秒沒poll就移除）- FORCE REDEPLOY
function cleanupStalePlayers() {
    const now = Date.now();
    const staleTimeout = 30000; // 30秒
    
    // 清理等待池中超時的玩家
    for (const name of diceState.waitingPlayers) {
        const player = diceState.players.get(name);
        if (!player || (now - player.lastPoll > staleTimeout)) {
            diceState.waitingPlayers = diceState.waitingPlayers.filter(p => p !== name);
            diceState.players.delete(name);
        }
    }
}

// 每10秒清理一次
setInterval(cleanupStalePlayers, 10000);

// 發送消息到伺服器（客戶端使用 POST）
app.post('/dice/action', (req, res) => {
    const { username, type } = req.body;
    if (!username) return res.status(400).json({ error: 'no username' });
    
    // 確保玩家在 players map 中
    if (!diceState.players.has(username)) {
        diceState.players.set(username, { lastPoll: Date.now(), pendingMessages: [] });
    }
    
    // 處理各種消息類型
    const msg = { type, username, ...req.body };
    handleDiceMessage(null, msg);
    
    res.json({ ok: true });
});

// ========== 輪盤遊戲邏輯（無 WebSocket） ==========
function getRouletteColor(num) {
    if (num === 0) return 'green';
    const reds = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
    return reds.includes(num) ? 'red' : 'black';
}

function spinWheel() {
    rouletteState.phase = 'spinning';
    
    // 庄家65%勝率機制
    // 策略：提高綠色(0)出現機率，讓玩家在顏色下注時長期虧損
    // 正常機率：P(0)=1/37≈2.7%
    // 調整後：P(0)≈20%，庄家勝率約65%
    
    const allNumbers = [
        {num:0,color:'green'},
        {num:32,color:'red'},{num:15,color:'black'},{num:19,color:'red'},{num:4,color:'black'},
        {num:21,color:'red'},{num:2,color:'black'},{num:25,color:'red'},{num:17,color:'black'},
        {num:34,color:'red'},{num:6,color:'black'},{num:27,color:'red'},{num:13,color:'black'},
        {num:36,color:'red'},{num:11,color:'black'},{num:30,color:'red'},{num:8,color:'black'},
        {num:23,color:'red'},{num:10,color:'black'},{num:5,color:'red'},{num:24,color:'black'},
        {num:16,color:'red'},{num:33,color:'black'},{num:1,color:'red'},{num:20,color:'black'},
        {num:14,color:'red'},{num:31,color:'black'},{num:9,color:'red'},{num:22,color:'black'},
        {num:18,color:'red'},{num:29,color:'black'},{num:7,color:'red'},{num:28,color:'black'},
        {num:12,color:'red'},{num:35,color:'black'},{num:3,color:'red'},{num:26,color:'black'}
    ];
    
    // 65%機率讓庄家贏（出0），35%正常隨機
    let selected;
    if (Math.random() < 0.65) {
        selected = allNumbers[0]; // 強製出0，庄家贏
    } else {
        const selectedIndex = Math.floor(Math.random() * 37);
        selected = allNumbers[selectedIndex];
    }
    
    rouletteState.lastSpin = { 
        result: selected.num, 
        color: selected.color, 
        time: Date.now() 
    };
    
    // HTTP輪詢模式：spinning 5秒 → 結果顯示3.5秒 → 下注8秒 → 循環
    setTimeout(() => {
        rouletteState.phase = 'result';
        // 結果顯示3.5秒後進入下注時間
        rouletteState.spinTimer = setTimeout(startBetting, 3500);
    }, 5000);
}

// 當玩家登入時呼叫
function playerJoined() {
    rouletteState.hasPlayer = true;
    if (rouletteState.phase === 'waiting') {
        startBetting();
    }
}

// 輪盤遊戲 - 玩家上線（保持遊戲運行）
app.post('/api/roulette/ping', (req, res) => {
    playerJoined();
    res.json({ success: true });
});

// 版本確認
app.get('/api/version', (req, res) => {
    res.json({ 
        version: 'v4.0-ACTUAL',
        deployTime: new Date().toISOString(),
        wsPath: '/dice'
    });
});

function startBetting() {
    if (!rouletteState.hasPlayer) {
        rouletteState.phase = 'waiting';
        return;
    }
    rouletteState.phase = 'betting';
    rouletteState.lastSpin = null;
    rouletteState.currentBets = [];
    rouletteState.phaseStartTime = Date.now();
    rouletteState.spinTimer = setTimeout(spinWheel, rouletteState.BETTING_TIME);
}

// 不再自動開始，等待玩家加入

// 輪盤 API
app.get('/api/roulette/status', (req, res) => {
    console.log('收到 roulette/status 請求');
    try {
        let remaining = 0;
        
        if (rouletteState.phase === 'betting') {
            const elapsed = (Date.now() - rouletteState.phaseStartTime) / 1000;
            remaining = Math.max(0, Math.ceil(rouletteState.BETTING_TIME / 1000 - elapsed));
        } else if (rouletteState.phase === 'result') {
            remaining = 5;
        }
        
        const response = {
            phase: rouletteState.phase,
            lastSpin: rouletteState.lastSpin,
            remaining: remaining
        };
        console.log('roulette/status 回應:', JSON.stringify(response));
        res.json(response);
    } catch(e) {
        console.log('roulette/status 錯誤:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/roulette/bet', (req, res) => {
    if (rouletteState.phase !== 'betting') {
        return res.json({ success: false, message: '現在不能下注' });
    }
    
    const { username, betType, amount, color, choice, number } = req.body;
    
    if (!username || !amount || amount < 10) {
        return res.json({ success: false, message: '請輸入正確的金額' });
    }
    
    res.json({ success: true, message: '下注成功！' });
});

// 輪盤遊戲 - 註冊
app.post('/api/roulette/register', async (req, res) => {
    console.log('收到註冊請求:', req.body);
    const { username, password } = req.body;
    if (!username || !password) {
        console.log('缺少帳號或密碼');
        return res.json({ success: false, message: '請填寫帳號和密碼' });
    }
    
    // 本地測試模式
    if (LOCAL_TEST_MODE) {
        if (localPlayers[username]) {
            return res.json({ success: false, message: '帳號已存在' });
        }
        localPlayers[username] = { password, score: 1000 };
        console.log('本地測試模式：註冊成功, username:', username);
        return res.json({ success: true, message: '註冊成功！' });
    }
    
    if (!rouletteDbAvailable || !rouletteDb) {
        console.log('輪盤資料庫不可用');
        return res.json({ success: false, message: '伺服器維護中' });
    }
    
    try {
        console.log('嘗試註冊用戶到輪盤資料庫:', username);
        
        // 先檢查帳號是否已存在
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('資料庫操作超時')), 5000);
        });
        
        const checkPromise = rouletteDb.execute({
            sql: `SELECT id FROM players WHERE username = ?`,
            args: [username]
        });
        
        const checkResult = await Promise.race([checkPromise, timeoutPromise]);
        
        if (checkResult.rows && checkResult.rows.length > 0) {
            console.log('帳號已存在, username:', username);
            return res.json({ success: false, message: '帳號已存在，請換一個' });
        }
        
        // 帳號不存在，執行註冊
        const executePromise = rouletteDb.execute({
            sql: `INSERT INTO players (username, password, score) VALUES (?, ?, 1000)`,
            args: [username, password]
        });
        
        const result = await Promise.race([executePromise, timeoutPromise]);
        console.log('註冊成功, result:', JSON.stringify(result));
        res.json({ success: true, message: '註冊成功！' });
    } catch(e) {
        console.log('註冊失敗, error:', e.message);
        res.json({ success: false, message: '帳號已存在，請換一個' });
    }
});

// 輪盤遊戲 - 登入
app.post('/api/roulette/login', async (req, res) => {
    const { username, password } = req.body;
    
    // 本地測試模式
    if (LOCAL_TEST_MODE) {
        if (localPlayers[username] && localPlayers[username].password === password) {
            console.log('本地測試模式：登入成功, username:', username, 'score:', localPlayers[username].score);
            playerJoined();
            return res.json({ success: true, player: { username, score: localPlayers[username].score } });
        }
        return res.json({ success: false, message: '帳號或密碼錯誤' });
    }
    
    if (!rouletteDbAvailable) return res.json({ success: false, message: '伺服器維護中' });
    
    try {
        const result = await rouletteDb.execute({
            sql: `SELECT * FROM players WHERE username = ? AND password = ?`,
            args: [username, password]
        });
        
        if (result.rows && result.rows.length > 0) {
            const row = result.rows[0];
            console.log('輪盤登入成功, username:', username, 'score:', row.score);
            playerJoined(); // 通知有玩家加入
            res.json({ success: true, player: { id: row.id, username: row.username, score: row.score, wins: row.wins || 0, losses: row.losses || 0 } });
        } else {
            res.json({ success: false, message: '帳號或密碼錯誤' });
        }
    } catch(e) {
        console.log('輪盤登入失敗:', e.message);
        res.json({ success: false, message: '登入失敗' });
    }
});

// 輪盤遊戲 - 更新余額
app.post('/api/roulette/update-score', async (req, res) => {
    const { username, newScore } = req.body;
    if (!username || typeof newScore !== 'number') {
        return res.json({ success: false, message: '參數錯誤' });
    }
    
    // 本地測試模式
    if (LOCAL_TEST_MODE) {
        if (localPlayers[username]) {
            localPlayers[username].score = newScore;
        }
        return res.json({ success: true });
    }
    
    if (!rouletteDbAvailable) return res.json({ success: false, message: '伺服器維護中' });
    
    try {
        await rouletteDb.execute({
            sql: `UPDATE players SET score = ? WHERE username = ?`,
            args: [newScore, username]
        });
        console.log('更新余額成功, username:', username, 'newScore:', newScore);
        res.json({ success: true });
    } catch(e) {
        console.log('更新余額失敗:', e.message);
        res.json({ success: false, message: '更新失敗' });
    }
});

// 輪盤遊戲 - 管理員：修改玩家餘額（老闆用）
app.post('/api/roulette/admin/update-score', async (req, res) => {
    const { username, newScore } = req.body;
    if (!username || newScore === undefined) {
        return res.json({ success: false, message: '請提供 username 和 newScore' });
    }
    
    // 本地測試模式
    if (LOCAL_TEST_MODE) {
        if (localPlayers[username]) {
            localPlayers[username].score = newScore;
        }
        return res.json({ success: true, message: `已將 ${username} 的餘額更新為 ${newScore}` });
    }
    
    if (!rouletteDbAvailable || !rouletteDb) {
        return res.json({ success: false, message: '資料庫不可用' });
    }
    
    try {
        await rouletteDb.execute({
            sql: `UPDATE players SET score = ? WHERE username = ?`,
            args: [newScore, username]
        });
        console.log(`管理員更新 ${username} 的餘額為 ${newScore}`);
        res.json({ success: true, message: `已將 ${username} 的餘額更新為 ${newScore}` });
    } catch(e) {
        console.log('更新餘額失敗:', e.message);
        res.json({ success: false, message: '更新失敗' });
    }
});

// 輪盤遊戲 - 保存歷史記錄
app.post('/api/roulette/save-history', async (req, res) => {
    const { username, result, color, win, amount } = req.body;
    if (!username) {
        return res.json({ success: false, message: '參數錯誤' });
    }
    
    // 本地測試模式
    if (LOCAL_TEST_MODE) {
        localHistory.unshift({ username, result, color, win, amount });
        if (localHistory.length > 100) localHistory.pop();
        return res.json({ success: true });
    }
    
    if (!rouletteDbAvailable) return res.json({ success: false, message: '伺服器維護中' });
    
    try {
        await rouletteDb.execute({
            sql: `INSERT INTO roulette_history (username, result, color, win, amount) VALUES (?, ?, ?, ?, ?)`,
            args: [username, result, color, win ? 1 : 0, amount]
        });
        res.json({ success: true });
    } catch(e) {
        console.log('保存歷史失敗:', e.message);
        res.json({ success: false, message: '保存失敗' });
    }
});

// 輪盤遊戲 - 清理過多歷史（每用戶最多100筆）
async function cleanupOldHistory() {
    if (!rouletteDbAvailable) return;
    try {
        await rouletteDb.execute({
            sql: `DELETE FROM roulette_history WHERE id NOT IN (SELECT id FROM roulette_history WHERE username, id IN (SELECT username, MAX(id) FROM roulette_history GROUP BY username) UNION SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY username ORDER BY id DESC) as rn FROM roulette_history) WHERE rn <= 100)`
        });
    } catch(e) {
        console.log('清理歷史失敗:', e.message);
    }
}

// 每小時清理一次
setInterval(cleanupOldHistory, 3600000);

// 輪盤遊戲 - 取得歷史記錄
app.get('/api/roulette/history/:username', async (req, res) => {
    const { username } = req.params;
    
    // 本地測試模式
    if (LOCAL_TEST_MODE) {
        const userHistory = localHistory.filter(h => h.username === username).slice(0, 100);
        return res.json({ history: userHistory });
    }
    
    if (!rouletteDbAvailable) return res.json({ history: [] });
    
    try {
        const result = await rouletteDb.execute({
            sql: `SELECT * FROM roulette_history WHERE username = ? ORDER BY id DESC LIMIT 100`,
            args: [username]
        });
        res.json({ history: result.rows || [] });
    } catch(e) {
        console.log('取得歷史失敗:', e.message);
        res.json({ history: [] });
    }
});

// 骰子遊戲 API（使用 Turso 資料庫）
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, message: '請填寫帳號和密碼' });
    if (!dbAvailable) return res.json({ success: false, message: '伺服器維護中' });
    
    try {
        await db.execute({
            sql: `INSERT INTO players (username, password, score) VALUES (?, ?, 100)`,
            args: [username, password]
        });
        res.json({ success: true, message: '註冊成功！' });
    } catch(e) {
        res.json({ success: false, message: '帳號已存在' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!dbAvailable) return res.json({ success: false, message: '伺服器維護中' });
    
    try {
        const result = await db.execute({
            sql: `SELECT * FROM players WHERE username = ? AND password = ?`,
            args: [username, password]
        });
        
        if (result.rows && result.rows.length > 0) {
            const row = result.rows[0];
            res.json({ success: true, player: { id: row.id, username: row.username, score: row.score, wins: row.wins, losses: row.losses, cheat: row.cheat } });
        } else {
            res.json({ success: false, message: '帳號或密碼錯誤' });
        }
    } catch(e) {
        res.json({ success: false, message: '登入失敗' });
    }
});

app.get('/api/players', async (req, res) => {
    if (!dbAvailable) return res.json({ players: [] });
    
    try {
        const result = await db.execute({
            sql: `SELECT username, score, wins, losses FROM players ORDER BY score DESC LIMIT 20`,
            args: []
        });
        res.json({ players: result.rows || [] });
    } catch(e) {
        res.json({ players: [] });
    }
});

// Admin: 更新玩家積分
app.post('/api/admin/update-score', async (req, res) => {
    const { username, change } = req.body;
    if (!dbAvailable) return res.json({ success: false, message: '資料庫不可用' });
    
    try {
        await db.execute({
            sql: 'UPDATE players SET score = score + ? WHERE username = ?',
            args: [change, username]
        });
        const result = await db.execute({
            sql: 'SELECT score FROM players WHERE username = ?',
            args: [username]
        });
        res.json({ success: true, username, newScore: result.rows?.[0]?.score ?? 0 });
    } catch(e) {
        res.json({ success: false, message: e.message });
    }
});

// Admin: 獲取玩家積分
app.get('/api/admin/score/:username', async (req, res) => {
    const { username } = req.params;
    if (!dbAvailable) return res.json({ score: null });
    
    try {
        const result = await db.execute({
            sql: 'SELECT score FROM players WHERE username = ?',
            args: [username]
        });
        res.json({ username, score: result.rows?.[0]?.score ?? 0 });
    } catch(e) {
        res.json({ username, score: null });
    }
});

// 獲取玩家積分（无需登录）
app.get('/api/score/:username', async (req, res) => {
    const { username } = req.params;
    if (!dbAvailable) return res.json({ score: null });
    
    try {
        const result = await db.execute({
            sql: 'SELECT score FROM players WHERE username = ?',
            args: [username]
        });
        res.json({ username, score: result.rows?.[0]?.score ?? 0 });
    } catch(e) {
        res.json({ username, score: null });
    }
});

app.get('/api/player/:username', async (req, res) => {
    if (!dbAvailable) return res.json({ player: null });
    
    try {
        const result = await db.execute({
            sql: `SELECT username, score, wins, losses FROM players WHERE username = ?`,
            args: [req.params.username]
        });
        if (result.rows && result.rows.length > 0) {
            res.json({ player: result.rows[0] });
        } else {
            res.json({ player: null });
        }
    } catch(e) {
        res.json({ player: null });
    }
});

// 靜態檔案
app.use('/dice', express.static(path.join(__dirname, 'public/dice')));
app.use('/roulette', express.static(path.join(__dirname, 'public/roulette')));
app.use('/mahjong', express.static(path.join(__dirname, 'public')));

// 首頁
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>T-LO 遊戲大廳</title>
            <style>
                body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #1a1a2e, #16213e); min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; color: white; }
                h1 { color: #ffd700; font-size: 2.5rem; margin-bottom: 30px; }
                .games { display: flex; gap: 30px; }
                .game-card { background: rgba(255,255,255,0.1); padding: 30px; border-radius: 20px; text-align: center; }
                .game-card h2 { color: #ffd700; margin-bottom: 15px; }
                .game-card a { display: inline-block; padding: 15px 30px; background: linear-gradient(135deg, #ffd700, #ff8c00); color: #1a1a2e; text-decoration: none; border-radius: 10px; font-weight: bold; margin-top: 15px; }
            </style>
        </head>
        <body>
            <h1>🎮 T-LO 遊戲大廳</h1>
            <div class="games">
                <div class="game-card">
                    <h2>🎲 骰子大作戰</h2>
                    <p>PvP 對戰遊戲</p>
                    <a href="/dice">開始玩</a>
                </div>
                <div class="game-card">
                    <h2>🎰 俄羅斯輪盤</h2>
                    <p>單人對戰</p>
                    <a href="/roulette">開始玩</a>
                </div>
            </div>
        </body>
        </html>
    `);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎮 T-LO 遊戲大廳已啟動!`);
    console.log(`   首頁: http://localhost:${PORT}/`);
    console.log(`   骰子遊戲: http://localhost:${PORT}/dice`);
    console.log(`   俄羅斯輪盤: http://localhost:${PORT}/roulette`);
});
// Fri Apr 17 23:08:45 CST 2026
// deploy 1776439288
// force 1776439667
// deploy 1776440618
// force deploy Fri Apr 17 23:52:59 CST 2026
// redeploy 1776441433
// deploy 1776491172
// force deploy 1776492179
// fix 1776492794
<!-- force deploy -->
