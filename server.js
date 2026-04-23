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
const localPlayers = {}; // { username: { password, score, invitedBy } }
const localFeedback = []; // { username, feedback, time }
const weeklyRewardConfig = { top1: 1000, top2: 800, top3: 500 }; // 每週前三名獎勵
let lastWeeklyReset = new Date().toISOString().split('T')[0]; // 用於追蹤每週結算
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
        // 建立 roulette_player_stats 表格（如果不存在）
        rouletteDb.execute({
            sql: `CREATE TABLE IF NOT EXISTS roulette_player_stats (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, total_bets INTEGER DEFAULT 0, total_wins INTEGER DEFAULT 0, total_losses INTEGER DEFAULT 0, total_win_amount INTEGER DEFAULT 0, total_lose_amount INTEGER DEFAULT 0)`
        }).catch(e => console.log('建立 roulette_player_stats 表格失敗:', e.message));
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
    hasPlayer: false,
    mysteryPool: 0  // 神秘彩池
};

// 輪盤廣告設定
const ROULETTE_ADS = [
    '/roulette/ad1.jpg',
    '/roulette/ad2.jpg',
    '/roulette/ad3.jpg',
    '/roulette/ad4.jpg',
    '/roulette/ad5.jpg'
];
let rouletteAdIndex = 0;
const ROULETTE_AD_RATE = 0.1;

function getNextRouletteAd() {
    rouletteAdIndex = (rouletteAdIndex + 1) % ROULETTE_ADS.length;
    return { url: ROULETTE_ADS[rouletteAdIndex], lineId: '@778ryayw' };
}

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
    
    const allNumbers = [
        {num:0,color:'gold'},
        {num:32,color:'red'},{num:15,color:'black'},{num:19,color:'red'},{num:4,color:'black'},
        {num:21,color:'red'},{num:2,color:'black'},{num:25,color:'red'},{num:17,color:'black'},
        {num:34,color:'red'},{num:6,color:'black'},{num:27,color:'red'},{num:13,color:'black'},
        {num:36,color:'red'},{num:11,color:'black'},{num:30,color:'red'},{num:8,color:'black'},
        {num:23,color:'red'},{num:10,color:'black'},{num:5,color:'red'},{num:24,color:'black'},
        {num:16,color:'red'},{num:33,color:'black'},{num:1,color:'red'},{num:20,color:'black'},
        {num:14,color:'red'},{num:31,color:'black'},{num:9,color:'red'},{num:22,color:'black'},
        {num:18,color:'red'},{num:29,color:'black'},{num:7,color:'red'},{num:28,color:'black'},
        {num:12,color:'red'},{num:35,color:'black'},{num:3,color:'red'},{num:26,color:'black'},
    ];
    
    const selectedIndex = Math.floor(Math.random() * 37);
    const selected = allNumbers[selectedIndex];
    
    // 簡化：假設1人中獎（伺服器結算時會重新計算）
    rouletteState.lastSpin = { 
        result: selected.num, 
        color: selected.color, 
        time: Date.now(),
        mystery: selected.num === 0,
        mysteryPool: selected.num === 0 ? rouletteState.mysteryPool : 0
    };
    // 大贏家廣播會在結算時由前端通知設定
    
    // 神秘中獎廣播（固定）
    if (selected.num === 0 && rouletteState.mysteryPool > 0) {
        rouletteState.lastWinner = {
            username: '神秘中獎者',
            amount: rouletteState.mysteryPool,
            time: Date.now(),
            type: 'mystery'
        };
        rouletteState.mysteryPool = 0;
        console.log('神秘中獎，彩池被領取');
    }
    
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
    rouletteState.lastWinner = null;
    rouletteState.bigWinner = null;  // 新一局開始
    rouletteState.phaseStartTime = Date.now();
    // 注意：mysteryPool 不在這裡重置，等有人中神秘後才重置
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
            // 如果剩餘時間為0但還在betting phase，強制開始轉盤
            if (remaining === 0 && rouletteState.phase === 'betting') {
                console.log('betting phase expired but spinning not triggered, forcing spin...');
                spinWheel();
            }
        } else if (rouletteState.phase === 'result') {
            remaining = 5;
        }
        
        const response = {
            phase: rouletteState.phase,
            lastSpin: rouletteState.lastSpin,
            remaining: remaining,
            mysteryPool: rouletteState.mysteryPool,
            lastWinner: rouletteState.lastWinner,
            bigWinner: rouletteState.bigWinner,  // 大贏家廣播
            ad: null
        };
        
        // 如果是result階段，隨機決定是否顯示廣告
        if (rouletteState.phase === 'result' && rouletteState.lastSpin) {
            response.ad = getNextRouletteAd();
        }
        console.log('roulette/status 回應:', JSON.stringify(response));
        res.json(response);
    } catch(e) {
        console.log('roulette/status 錯誤:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/roulette/bet', async (req, res) => {
    if (rouletteState.phase !== 'betting') {
        return res.json({ success: false, message: '現在不能下注' });
    }
    
    const { username, betType, amount, color, choice, number } = req.body;
    
    if (!username || !amount || amount < 10) {
        return res.json({ success: false, message: '請輸入正確的金額' });
    }
    
    // 檢查玩家餘額是否足夠
    let playerScore = 0;
    if (LOCAL_TEST_MODE) {
        playerScore = localPlayers[username]?.score || 0;
    } else if (rouletteDbAvailable) {
        try {
            const r = await rouletteDb.execute({
                sql: `SELECT score FROM players WHERE username = ?`,
                args: [username]
            });
            if (r.rows && r.rows.length > 0) {
                playerScore = r.rows[0].score || 0;
            }
        } catch(e) {
            console.log('取得玩家分數失敗:', e.message);
        }
    }
    
    // 如果餘額不足 10 分，拒絕下注
    if (playerScore < 10) {
        return res.json({ success: false, message: '餘額不足，無法下注' });
    }
    
    // 隨機獎勵：3% 機會觸發 200 分 bonus
    let bonusTriggered = false;
    let bonusAmount = 0;
    if (Math.random() < 0.03) {
        bonusTriggered = true;
        bonusAmount = 200;
        console.log('🎁 隨機獎勵觸發! username:', username, 'bonus:', bonusAmount);
        
        // 立即發放獎勵到帳戶
        if (LOCAL_TEST_MODE) {
            if (localPlayers[username]) localPlayers[username].score += bonusAmount;
        } else if (rouletteDbAvailable) {
            rouletteDb.execute({
                sql: `UPDATE players SET score = score + ? WHERE username = ?`,
                args: [bonusAmount, username]
            }).catch(e => console.log('發放隨機獎勵失敗:', e.message));
        }
    }
    
    // 1% 进神秘彩池（所有下注都进）
    const poolContribution = Math.floor(amount * 0.01);
    rouletteState.mysteryPool += poolContribution;
    console.log('下注进彩池: $' + poolContribution + ', 彩池总计: $' + rouletteState.mysteryPool);
    // 保存下注到資料庫
    if (!LOCAL_TEST_MODE && rouletteDb) {
        const betType = choice === '0' ? 'number' : (color || betType || 'unknown');
        const betValue = choice || number || '';
        rouletteDb.execute({
            sql: `INSERT INTO roulette_bets (username, round_time, bet_type, bet_value, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            args: [username, rouletteState.phaseStartTime, betType, String(betValue), amount, new Date().toISOString()]
        }).catch(e => console.log('保存下注失敗:', e.message));
    }
    
    res.json({ success: true, message: '下注成功！', bonusTriggered, bonusAmount, poolContribution, mysteryPool: rouletteState.mysteryPool });

// 管理員設定神秘彩池
app.post('/api/roulette/admin/set-pool', async (req, res) => {
    const { amount } = req.body;
    if (typeof amount !== 'number' || amount < 0) {
        return res.json({ success: false, message: '請提供有效的金額' });
    }
    rouletteState.mysteryPool = amount;
    console.log('管理員設定神秘彩池:', amount);
    res.json({ success: true, mysteryPool: rouletteState.mysteryPool });
});


// 看片領金幣
app.post('/api/roulette/claim-video', async (req, res) => {
    const { username } = req.body;
    if (!username) return res.json({ success: false, message: '請先登入' });
    
    const today = new Date().toISOString().split('T')[0];
    
    if (LOCAL_TEST_MODE) {
        const player = localPlayers[username];
        if (!player) return res.json({ success: false, message: '玩家不存在' });
        if (player.lastVideoClaim === today) {
            return res.json({ success: false, message: '今天已領過了，明天再來！' });
        }
        player.score += 1000;
        player.lastVideoClaim = today;
        return res.json({ success: true, amount: 1000, newScore: player.score });
    }
    
    if (!rouletteDbAvailable || !rouletteDb) {
        return res.json({ success: false, message: '伺服器維護中' });
    }
    
    try {
        const check = await rouletteDb.execute({
            sql: `SELECT lastVideoClaim FROM players WHERE username = ?`,
            args: [username]
        });
        
        if (check.rows && check.rows.length > 0) {
            const last = check.rows[0].lastVideoClaim || '';
            if (last === today) {
                return res.json({ success: false, message: '今天已領過了，明天再來！' });
            }
        }
        
        await rouletteDb.execute({
            sql: `UPDATE players SET score = score + 1000, lastVideoClaim = ? WHERE username = ?`,
            args: [today, username]
        });
        
        const scoreResult = await rouletteDb.execute({
            sql: `SELECT score FROM players WHERE username = ?`,
            args: [username]
        });
        const newScore = scoreResult.rows ? scoreResult.rows[0].score : 0;
        
        console.log('看片領金幣成功:', username, '+1000');
        res.json({ success: true, amount: 1000, newScore });
    } catch(e) {
        console.log('claim-video錯誤:', e.message);

// 大贏家廣播（赢超過1000就廣播）
app.post('/api/roulette/broadcast-win', async (req, res) => {
    const { username, amount } = req.body;
    if (!username || !amount) return res.json({ success: false, message: '缺少參數' });
    
    if (amount >= 1000) {
        rouletteState.bigWinner = { username, amount, time: Date.now() };
        console.log('大贏家廣播:', username, '赢了', amount);
        res.json({ success: true, broadcast: true });
    } else {
        res.json({ success: true, broadcast: false });
    }
});

        res.json({ success: false, message: '領取失敗，請稍後再試' });
    }
});

});

// 輪盤遊戲 - 註冊
app.post('/api/roulette/register', async (req, res) => {
    console.log('收到註冊請求:', req.body);
    const { username, password, realname, phone, email } = req.body;
    if (!username || !password) {
        console.log('缺少帳號或密碼');
        return res.json({ success: false, message: '請填寫帳號和密碼' });
    }
    
    // 處理邀請碼
    const { inviteCode } = req.body;
    let inviterBonus = 0;
    
    // 本地測試模式
    if (LOCAL_TEST_MODE) {
        if (localPlayers[username]) {
            return res.json({ success: false, message: '帳號已存在' });
        }
        localPlayers[username] = { password, score: 1000, realname, phone, email, invitedBy: inviteCode || null };
        // 邀請人獲得獎勵
        if (inviteCode && localPlayers[inviteCode]) {
            localPlayers[inviteCode].score += 200;
            inviterBonus = 200;
            console.log('邀請獎勵發放:', inviteCode, '+200, 帳戶:', localPlayers[inviteCode].score);
        }
        console.log('本地測試模式：註冊成功, username:', username, '| 姓名:', realname, '| 電話:', phone, '| 信箱:', email);
        return res.json({ success: true, message: '註冊成功！', inviterBonus });
    }
    
    if (!rouletteDbAvailable || !rouletteDb) {
        console.log('輪盤資料庫不可用');
        return res.json({ success: false, message: '伺服器維護中' });
    }
    
    try {
        console.log('嘗試註冊用戶到輪盤資料庫:', username, '| 姓名:', realname, '| 電話:', phone, '| 信箱:', email);
        
        // 先檢查帳號是否已存在
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('資料庫操作超時')), 5000);
        });
        
        // 只檢查有值的phone/email，避免空字串匹配既有用戶
        let checkSql = `SELECT id FROM players WHERE username = ?`;
        let checkArgs = [username];
        if (phone && phone.trim()) {
            checkSql += ` OR phone = ?`;
            checkArgs.push(phone.trim());
        }
        if (email && email.trim()) {
            checkSql += ` OR email = ?`;
            checkArgs.push(email.trim());
        }
        
        const checkPromise = rouletteDb.execute({ sql: checkSql, args: checkArgs });
        
        const checkResult = await Promise.race([checkPromise, timeoutPromise]);
        
        if (checkResult.rows && checkResult.rows.length > 0) {
            // 檢查是哪個重複
            const existing = checkResult.rows[0];
            // 這裡不做嚴格區分，統一提示
            console.log('註冊重複, username:', username, 'phone:', phone, 'email:', email);
            return res.json({ success: false, message: '此電話或信箱已被註冊過' });
        }
        
        // 帳號不存在，執行註冊（嘗試包含新欄位）
        try {
            const executePromise = rouletteDb.execute({
                sql: `INSERT INTO players (username, password, score, realname, phone, email) VALUES (?, ?, 1000, ?, ?, ?)`,
                args: [username, password, realname || '', phone || '', email || '']
            });
            await Promise.race([executePromise, timeoutPromise]);
        } catch(dbErr) {
            // 如果新欄位不存在，退回只插入基本欄位
            console.log('新欄位插入失敗，退回基本欄位:', dbErr.message);
            const fallbackPromise = rouletteDb.execute({
                sql: `INSERT INTO players (username, password, score) VALUES (?, ?, 1000)`,
                args: [username, password]
            });
            await Promise.race([fallbackPromise, timeoutPromise]);
        }
        
        console.log('註冊成功, username:', username);
        res.json({ success: true, message: '註冊成功！' });
    } catch(e) {
        console.log('註冊失敗, error:', e.message);
        // 細分錯誤類型
        if (e.message.includes('UNIQUE') || e.message.includes('duplicate') || e.message.includes('已存在')) {
            res.json({ success: false, message: '此帳號或電話/信箱已被註冊過' });
        } else {
            res.json({ success: false, message: '註冊失敗，請稍後再試' });
        }
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
            
            // 每日登入獎勵：先用 lastLogin 欄位判斷（如果欄位存在且有效才發放）
            // 如果 lastLogin 欄位不存在或無效，則不發放（避免每次登入都發放）
            let dailyBonus = 0;
            const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
            const lastLogin = row.lastLogin;
            
            // 只在 lastLogin 有值且不是今天時才發放（或是空值也表示從未領過，直接發放）
            if (!lastLogin || lastLogin !== today) {
                dailyBonus = 1000;
                console.log('每日登入獎勵! username:', username, 'bonus:', dailyBonus);
                try {
                    await rouletteDb.execute({
                        sql: `UPDATE players SET lastLogin = ?, score = score + ? WHERE username = ?`,
                        args: [today, dailyBonus, username]
                    });
                } catch(e) {
                    console.log('更新每日獎勵失敗:', e.message);
                }
            }
            
            const newScore = (row.score || 0) + dailyBonus;
            console.log('輪盤登入成功, username:', username, 'score:', newScore, 'dailyBonus:', dailyBonus, 'lastLogin:', lastLogin);
            playerJoined(); // 通知有玩家加入
            res.json({ success: true, player: { id: row.id, username: row.username, score: newScore, wins: row.wins || 0, losses: row.losses || 0, dailyBonus } });
        } else {
            res.json({ success: false, message: '帳號或密碼錯誤' });
        }
    } catch(e) {
        console.log('輪盤登入失敗:', e.message);
        res.json({ success: false, message: '登入失敗' });
    }
});

// 輪盤遊戲 - 排行榜
app.get('/api/roulette/leaderboard', async (req, res) => {
    if (LOCAL_TEST_MODE) {
        // 本地模式：取 localPlayers 前10名
        const sorted = Object.entries(localPlayers)
            .map(([username, data]) => ({ username, score: data.score || 0 }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 10);
        return res.json({ success: true, leaderboard: sorted });
    }
    
    if (!rouletteDbAvailable) return res.json({ success: false, message: '伺服器維護中' });
    
    try {
        const result = await rouletteDb.execute({
            sql: `SELECT username, score FROM players ORDER BY score DESC LIMIT 15`
        });
        console.log('排行榜查詢成功, count:', result.rows?.length || 0);
        res.json({ success: true, leaderboard: result.rows || [] });
    } catch(e) {
        console.log('排行榜查詢失敗:', e.message);
        res.json({ success: false, message: '查詢失敗' });
    }
});

// 每週排行榜獎勵發放（每週一凌晨結算）
function processWeeklyRewards() {
    const today = new Date().toISOString().split('T')[0];
    if (lastWeeklyReset === today) return; // 今天已結算
    
    // 檢查是否週一（ISO weekday: 1 = Monday）
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek !== 1) return; // 不是週一不結算
    
    console.log('🎁 開始結算每週排行榜獎勵...');
    
    if (LOCAL_TEST_MODE) {
        // 本地模式：取前三名發獎
        const sorted = Object.entries(localPlayers)
            .map(([username, data]) => ({ username, score: data.score || 0 }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 3);
        
        const rewards = [1000, 800, 500];
        sorted.forEach((player, i) => {
            if (localPlayers[player.username]) {
                localPlayers[player.username].score += rewards[i];
                console.log(`每週獎勵: ${player.username} +${rewards[i]}`);
            }
        });
    } else if (rouletteDbAvailable) {
        // 資料庫模式：查前三名並發獎
        rouletteDb.execute({
            sql: `SELECT username, score FROM players ORDER BY score DESC LIMIT 3`
        }).then(result => {
            const rewards = [1000, 800, 500];
            (result.rows || []).forEach((player, i) => {
                rouletteDb.execute({
                    sql: `UPDATE players SET score = score + ? WHERE username = ?`,
                    args: [rewards[i], player.username]
                }).then(() => {
                    console.log(`每週獎勵: ${player.username} +${rewards[i]}`);
                    // 發 Discord 公告
                    fetch(DISCORD_WEBHOOK, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            content: `🏆 **每週排行榜獎勵**\n🥇 ${result.rows[0]?.username || '-'} +1000分\n🥈 ${result.rows[1]?.username || '-'} +800分\n🥉 ${result.rows[2]?.username || '-'} +500分`
                        })
                    });
                });
            });
        });
    }
    
    lastWeeklyReset = today;
}

// 每小時檢查一次是否需要結算
setInterval(processWeeklyRewards, 3600000);
processWeeklyRewards(); // 啟動時也檢查一次

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

// 輪盤遊戲 - 管理員：修補資料庫（新增lastLogin欄位）
app.post('/api/roulette/admin/fix-daily-bonus', async (req, res) => {
    if (!rouletteDbAvailable || !rouletteDb) {
        return res.json({ success: false, message: '資料庫不可用' });
    }
    try {
        // 嘗試新增 lastLogin 欄位（如果已存在會失敗，但這是預期的）
        await rouletteDb.execute({
            sql: `ALTER TABLE players ADD COLUMN lastLogin TEXT DEFAULT ''`
        });
        console.log('已新增 lastLogin 欄位');
        res.json({ success: true, message: '已新增 lastLogin 欄位' });
    } catch(e) {
        if (e.message.includes('duplicate column')) {
            res.json({ success: true, message: 'lastLogin 欄位已存在' });
        } else {
            console.log('修補失敗:', e.message);
            res.json({ success: false, message: '修補失敗: ' + e.message });
        }
    }
});

// 輪盤遊戲 - 管理員：修改玩家帳號名稱
app.post('/api/roulette/admin/update-username', async (req, res) => {
    const { oldUsername, newUsername } = req.body;
    if (!oldUsername || !newUsername) {
        return res.json({ success: false, message: '請提供 oldUsername 和 newUsername' });
    }
    
    if (LOCAL_TEST_MODE) {
        if (localPlayers[oldUsername]) {
            localPlayers[newUsername] = { ...localPlayers[oldUsername] };
            delete localPlayers[oldUsername];
        }
        return res.json({ success: true, message: `已將 ${oldUsername} 改為 ${newUsername}` });
    }
    
    if (!rouletteDbAvailable || !rouletteDb) {
        return res.json({ success: false, message: '資料庫不可用' });
    }
    
    try {
        // 檢查新帳號是否已存在
        const check = await rouletteDb.execute({
            sql: `SELECT id FROM players WHERE username = ?`,
            args: [newUsername]
        });
        if (check.rows && check.rows.length > 0) {
            return res.json({ success: false, message: '新帳號已存在' });
        }
        
        await rouletteDb.execute({
            sql: `UPDATE players SET username = ? WHERE username = ?`,
            args: [newUsername, oldUsername]
        });
        console.log(`管理員將 ${oldUsername} 改為 ${newUsername}`);
        res.json({ success: true, message: `已將 ${oldUsername} 改為 ${newUsername}` });
    } catch(e) {
        console.log('修改帳號失敗:', e.message);
        res.json({ success: false, message: '修改失敗' });
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
        // 更新玩家統計資料表
        try {
            await rouletteDb.execute({
                sql: `INSERT INTO roulette_player_stats (username, total_bets, total_wins, total_losses, total_win_amount, total_lose_amount) VALUES (?, 1, ?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET total_bets = total_bets + 1, total_wins = total_wins + ?, total_losses = total_losses + ?, total_win_amount = total_win_amount + ?, total_lose_amount = total_lose_amount + ?`,
                args: [username, win ? 1 : 0, win ? 0 : 1, win ? amount : 0, win ? 0 : amount, win ? 1 : 0, win ? 0 : 1, win ? amount : 0, win ? 0 : amount]
            });
        } catch(e2) {
            console.log('更新玩家統計失敗:', e2.message);
        }
        res.json({ success: true });
    } catch(e) {
        console.log('保存歷史失敗:', e.message);
        res.json({ success: false, message: '保存失敗' });
    }
});

// 輪盤遊戲 - 玩家反饋（發送到 Discord）
const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1491323033952473098/OYa经营活动/PhCXZ4K_gREhKGjd1YPaXp0nGdCXa4xYqJqJ8SpW7Y1lvNM3sMh-FqLGRm3Z4qZq';

app.post('/api/roulette/feedback', async (req, res) => {
    const { username, feedback } = req.body;
    if (!username || !feedback) {
        return res.json({ success: false, message: '參數錯誤' });
    }
    
    console.log('收到玩家反饋:', username, '-', feedback);
    
    // 本地模式：存入 localFeedback
    if (LOCAL_TEST_MODE) {
        localFeedback.unshift({ username, feedback, time: new Date().toISOString() });
    } else if (rouletteDbAvailable) {
        // 存入資料庫
        try {
            await rouletteDb.execute({
                sql: `INSERT INTO roulette_feedback (username, feedback, createdAt) VALUES (?, ?, ?)`,
                args: [username, feedback, new Date().toISOString()]
            });
        } catch(e) {
            // 表格可能不存在，先建立
            try {
                await rouletteDb.execute({
                    sql: `CREATE TABLE IF NOT EXISTS roulette_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, feedback TEXT, createdAt TEXT)`
                });
                await rouletteDb.execute({
                    sql: `INSERT INTO roulette_feedback (username, feedback, createdAt) VALUES (?, ?, ?)`,
                    args: [username, feedback, new Date().toISOString()]
                });
            } catch(e2) {
                console.log('儲存反饋失敗:', e2.message);
            }
        }
    }
    
    // 發送到 Discord
    try {
        await fetch(DISCORD_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: `📩 **輪盤遊戲反饋**\n👤 玩家：**${username}**\n💬 內容：${feedback}`
            })
        });
    } catch(e) {
        console.log('發送 Discord 失敗:', e.message);
    }
    
    res.json({ success: true });
});

// 輪盤遊戲 - 管理員：查看所有玩家輸贏統計
app.get('/api/roulette/admin/stats', async (req, res) => {
    if (LOCAL_TEST_MODE) {
        return res.json({ success: true, stats: [] });
    }
    if (!rouletteDbAvailable) return res.json({ success: false, message: '資料庫不可用' });
    try {
        const result = await rouletteDb.execute({
            sql: `SELECT username, COUNT(*) as total_bets, SUM(amount) as total_staked, SUM(win) as net_profit FROM roulette_history GROUP BY username ORDER BY net_profit DESC`
        });
        res.json({ success: true, stats: result.rows || [] });
    } catch(e) {
        console.log('查詢統計失敗:', e.message);
        res.json({ success: false, message: '查詢失敗' });
    }
});

// 輪盤遊戲 - 管理員：查看所有反饋
app.get('/api/roulette/admin/feedback', async (req, res) => {
    if (LOCAL_TEST_MODE) {
        return res.json({ success: true, feedback: localFeedback.slice(0, 50) });
    }
    if (!rouletteDbAvailable) return res.json({ success: false, message: '資料庫不可用' });
    try {
        const result = await rouletteDb.execute({
            sql: `SELECT * FROM roulette_feedback ORDER BY id DESC LIMIT 100`
        });
        res.json({ success: true, feedback: result.rows || [] });
    } catch(e) {
        console.log('查詢反饋失敗:', e.message);
        res.json({ success: false, message: '查詢失敗' });
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
app.use('/coin-roulette', express.static(path.join(__dirname, 'public/coin-roulette')));

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
                <div class="game-card">
                    <h2>🪙 T-LO轉轉金幣</h2>
                    <p>金幣輪盤</p>
                    <a href="/coin-roulette">開始玩</a>
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
    console.log(`   T-LO轉轉金幣: http://localhost:${PORT}/coin-roulette`);
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


// =====================================================
// T-LO轉轉金幣 遊戲（整合到 unified-games）
// =====================================================

const coinDbUrl = process.env.COIN_DATABASE_URL || 'libsql://lbr-coin-lbr-schedule.aws-ap-northeast-1.turso.io';
const coinDbAuthToken = process.env.COIN_DATABASE_AUTH_TOKEN || '';
let coinDb = null;
let coinDbAvailable = false;
const COIN_LOCAL_TEST_MODE = !process.env.COIN_DATABASE_URL;

if (COIN_LOCAL_TEST_MODE) {
    coinDbAvailable = true;
    coinDb = { execute: async () => {} };
} else {
    try {
        coinDb = createClient({ url: coinDbUrl, authToken: coinDbAuthToken });
        coinDbAvailable = true;
        console.log('轉轉金幣資料庫 Client 已建立, URL:', coinDbUrl);
    } catch(e) { console.log('轉轉金幣資料庫建立失敗:', e.message); coinDbAvailable = false; }
}

const COIN_ADS = [
    'https://minimax-algeng-chat-tts-us.oss-us-east-1.aliyuncs.com/ccv2%2F2026-04-23%2FMiniMax-M2.7%2F2042085561899950328%2F41db7be8f36a75e27f698c7df2fc38df8278dd34134649679ec7fc3b87a40e67..jpeg?Expires=1776999011&OSSAccessKeyId=LTAI5tCpJNKCf5EkQHSuL9xg&Signature=9fK03qy9LM0R26FbUmQ%2Frpic95w%3D',
    'https://minimax-algeng-chat-tts-us.oss-us-east-1.aliyuncs.com/ccv2%2F2026-04-23%2FMiniMax-M2.7%2F2042085561899950328%2Fa0341b29441c11c1b49b7514a4ea8fa9af655cc2b25a2048a4bcf5ab22e34085..jpeg?Expires=1776999012&OSSAccessKeyId=LTAI5tCpJNKCf5EkQHSuL9xg&Signature=kEMJ4XjrLxYNffDgsNlPZiGPucc%3D',
    'https://minimax-algeng-chat-tts-us.oss-us-east-1.aliyuncs.com/ccv2%2F2026-04-23%2FMiniMax-M2.7%2F2042085561899950328%2F350fd95706f0eb5aef392f05fd99445ae08df872e58bfc779709ffb2a75c9f24..jpeg?Expires=1776999015&OSSAccessKeyId=LTAI5tCpJNKCf5EkQHSuL9xg&Signature=acG3Lmo8tDhvvMEEm2MxpEB3O00%3D',
    'https://minimax-algeng-chat-tts-us.oss-us-east-1.aliyuncs.com/ccv2%2F2026-04-23%2FMiniMax-M2.7%2F2042085561899950328%2F9ef5d9059c89dac79deb2b2d5f3d1da9b3a3adf56fc381004f723472e2f46036..jpeg?Expires=1776999017&OSSAccessKeyId=LTAI5tCpJNKCf5EkQHSuL9xg&Signature=pbSyposxvOaOR0nbMOunumGG3PY%3D',
    'https://minimax-algeng-chat-tts-us.oss-us-east-1.aliyuncs.com/ccv2%2F2026-04-23%2FMiniMax-M2.7%2F2042085561899950328%2F7efef79fad4fa853d54803b00f59ba398679ff890442413343be9fb93adaab0b..jpeg?Expires=1776999020&OSSAccessKeyId=LTAI5tCpJNKCf5EkQHSuL9xg&Signature=G0cMAG1lE%2FAzzScU%2FP7En9c6h8g%3D'
];
let coinAdIndex = 0;
const COIN_AD_RATE = 0.1;

const COIN_REWARDS = [
    { multiplier: 8, weight: 1 },
    { multiplier: 3, weight: 6 },
    { multiplier: 1.5, weight: 18 },
    { multiplier: 1, weight: 20 },
    { multiplier: 0.5, weight: 25 },
    { multiplier: 0, weight: 30 }
];

const coinPlayerSessions = {};

function getCoinSession(userId) {
    if (!coinPlayerSessions[userId]) {
        coinPlayerSessions[userId] = { pulls: 0, totalBet: 0, totalWin: 0, loseStreak: 0, dailyWin: 0, lastReset: new Date().toDateString() };
    }
    const s = coinPlayerSessions[userId];
    if (s.lastReset !== new Date().toDateString()) { s.dailyWin = 0; s.lastReset = new Date().toDateString(); }
    return s;
}

function calcCoinWeights(s, base) {
    const w = [...base];
    const phase = s.pulls < 10 ? 'early' : s.pulls < 25 ? 'mid' : 'late';
    if (phase === 'early') { w[0] *= 3; w[1] *= 2; w[2] *= 1.5; }
    else if (phase === 'late') { w[0] /= 3; w[1] /= 2; w[2] /= 1.5; }
    if (s.loseStreak >= 10) { w[2] = Math.max(w[2], 50); w[3] = Math.max(w[3], 20); }
    if (s.totalBet > 0) {
        const rtp = s.totalWin / s.totalBet;
        if (rtp > 0.8) { w[0] /= 2; w[1] /= 1.5; }
        else if (rtp < 0.6 && s.totalBet > 1000) { w[0] *= 1.5; w[1] *= 1.2; }
    }
    if (s.dailyWin > 50000) { w[0] = 0; w[1] /= 3; w[2] /= 2; }
    return w.map(x => Math.max(x, 0.1));
}

function coinWeightedRandom(weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
    return weights.length - 1;
}

function getNextCoinAd() {
    coinAdIndex = (coinAdIndex + 1) % COIN_ADS.length;
    return { url: COIN_ADS[coinAdIndex], lineId: '@778ryayw' };
}

// 初始化轉轉金幣資料表
async function initCoinTables() {
    if (COIN_LOCAL_TEST_MODE || !coinDbAvailable) return;
    try {
        await coinDb.execute({ sql: `CREATE TABLE IF NOT EXISTS coin_users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, coin_balance INTEGER DEFAULT 1000, total_bet INTEGER DEFAULT 0, total_win INTEGER DEFAULT 0, realname TEXT, phone TEXT, email TEXT, invited_by TEXT, created_at TEXT)` });
        await coinDb.execute({ sql: `CREATE TABLE IF NOT EXISTS coin_spin_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, bet_amount INTEGER, reward INTEGER, multiplier REAL, timestamp TEXT)` });
        await coinDb.execute({ sql: `CREATE TABLE IF NOT EXISTS coin_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, feedback TEXT, created_at TEXT)` });
        await coinDb.execute({ sql: `CREATE TABLE IF NOT EXISTS coin_player_stats (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, total_bets INTEGER DEFAULT 0, total_wins INTEGER DEFAULT 0, total_losses INTEGER DEFAULT 0, total_win_amount INTEGER DEFAULT 0, total_lose_amount INTEGER DEFAULT 0)` });
        console.log('轉轉金幣資料表初始化成功');
    } catch(e) { console.log('轉轉金幣資料表初始化失敗:', e.message); }
}
initCoinTables();

// 轉轉金幣 API
app.post('/api/coin/register', async (req, res) => {
    const { username, password, realname, phone, email, inviteCode } = req.body;
    if (!username || !password) return res.json({ success: false, message: '請填寫帳號和密碼' });
    if (!realname || !phone) return res.json({ success: false, message: '請填寫姓名和電話' });
    if (COIN_LOCAL_TEST_MODE) return res.json({ success: true, message: '註冊成功！獲得 1000 金幣！' });
    if (!coinDbAvailable) return res.json({ success: false, message: '資料庫連線失敗，請稍後再試' });
    try {
        const check = await coinDb.execute({ sql: `SELECT id FROM coin_users WHERE username = ?`, args: [username] });
        if (check.rows && check.rows.length > 0) return res.json({ success: false, message: '帳號已存在' });
        await coinDb.execute({ sql: `INSERT INTO coin_users (username, password, coin_balance, realname, phone, email, invited_by) VALUES (?, ?, 1000, ?, ?, ?, ?)`, args: [username, password, realname, phone, email || '', inviteCode || ''] });
        if (inviteCode) {
            await coinDb.execute({ sql: `UPDATE coin_users SET coin_balance = coin_balance + 200 WHERE username = ?`, args: [inviteCode] });
            await coinDb.execute({ sql: `UPDATE coin_users SET coin_balance = coin_balance + 200 WHERE username = ?`, args: [username] });
        }
        res.json({ success: true, message: '註冊成功！獲得 1000 金幣！' });
    } catch(e) { console.log('轉轉金幣註冊失敗:', e.message); res.json({ success: false, message: '註冊失敗' }); }
});

app.post('/api/coin/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, message: '請填寫帳號和密碼' });
    if (COIN_LOCAL_TEST_MODE) return res.json({ success: true, player: { username, balance: 1000, total_bet: 0, total_win: 0 } });
    if (!coinDbAvailable) return res.json({ success: false, message: '資料庫連線失敗，請稍後再試' });
    try {
        const result = await coinDb.execute({ sql: `SELECT * FROM coin_users WHERE username = ? AND password = ?`, args: [username, password] });
        if (result.rows && result.rows.length > 0) {
            const row = result.rows[0];
            res.json({ success: true, player: { username: row.username, balance: row.coin_balance, total_bet: row.total_bet, total_win: row.total_win } });
        } else {
            res.json({ success: false, message: '帳號或密碼錯誤' });
        }
    } catch(e) { console.log('轉轉金幣登入失敗:', e.message); res.json({ success: false, message: '登入失敗' }); }
});

app.get('/api/coin/leaderboard', async (req, res) => {
    if (COIN_LOCAL_TEST_MODE) return res.json({ success: true, leaderboard: [] });
    if (!coinDbAvailable) return res.json({ success: false, leaderboard: [] });
    try {
        const result = await coinDb.execute({ sql: `SELECT username, coin_balance as balance FROM coin_users ORDER BY coin_balance DESC LIMIT 15` });
        res.json({ success: true, leaderboard: result.rows || [] });
    } catch(e) { res.json({ success: false, leaderboard: [] }); }
});

app.get('/api/coin/history/:username', async (req, res) => {
    const { username } = req.params;
    if (COIN_LOCAL_TEST_MODE) return res.json({ success: true, history: [] });
    if (!coinDbAvailable) return res.json({ success: false, history: [] });
    try {
        const result = await coinDb.execute({ sql: `SELECT * FROM coin_spin_logs WHERE username = ? ORDER BY id DESC LIMIT 100`, args: [username] });
        res.json({ success: true, history: result.rows || [] });
    } catch(e) { res.json({ success: false, history: [] }); }
});

app.post('/api/coin/feedback', async (req, res) => {
    const { username, feedback } = req.body;
    if (!username || !feedback) return res.json({ success: false, message: '參數錯誤' });
    if (COIN_LOCAL_TEST_MODE) return res.json({ success: true });
    if (!coinDbAvailable) return res.json({ success: false, message: '資料庫連線失敗' });
    try {
        await coinDb.execute({ sql: `INSERT INTO coin_feedback (username, feedback, created_at) VALUES (?, ?, ?)`, args: [username, feedback, new Date().toISOString()] });
        res.json({ success: true });
    } catch(e) { res.json({ success: false, message: '儲存失敗' }); }
});

app.post('/api/coin/spin', async (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.json({ error: 'user_id is required' });
    const s = getCoinSession(user_id);
    const BET = 100;
    s.pulls++;
    const w = calcCoinWeights(s, COIN_REWARDS.map(r => r.weight));
    const idx = coinWeightedRandom(w);
    const reward = COIN_REWARDS[idx];
    const coins = Math.floor(BET * reward.multiplier);
    s.totalBet += BET;
    s.totalWin += coins;
    s.dailyWin += (coins - BET);
    if (reward.multiplier <= 1) s.loseStreak++;
    else s.loseStreak = 0;
    const showAd = Math.random() < COIN_AD_RATE;
    const ad = showAd ? getNextCoinAd() : null;
    if (!COIN_LOCAL_TEST_MODE && coinDbAvailable) {
        try {
            await coinDb.execute({ sql: `INSERT INTO coin_spin_logs (username, bet_amount, reward, multiplier, timestamp) VALUES (?, ?, ?, ?, ?)`, args: [user_id, BET, coins, reward.multiplier, new Date().toISOString()] });
            await coinDb.execute({ sql: `UPDATE coin_users SET coin_balance = coin_balance + ?, total_bet = total_bet + ?, total_win = total_win + ? WHERE username = ?`, args: [coins - BET, BET, coins, user_id] });
            // 更新玩家統計
            const isWin = reward.multiplier > 1;
            const winAmt = isWin ? coins - BET : 0;
            const loseAmt = !isWin ? BET - coins : 0;
            await coinDb.execute({ sql: `INSERT INTO coin_player_stats (username, total_bets, total_wins, total_losses, total_win_amount, total_lose_amount) VALUES (?, 1, ?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET total_bets = total_bets + 1, total_wins = total_wins + ?, total_losses = total_losses + ?, total_win_amount = total_win_amount + ?, total_lose_amount = total_lose_amount + ?`, args: [user_id, isWin?1:0, isWin?0:1, winAmt, loseAmt, isWin?1:0, isWin?0:1, winAmt, loseAmt] });
            const bal = await coinDb.execute({ sql: `SELECT coin_balance FROM coin_users WHERE username = ?`, args: [user_id] });
            const balance = bal.rows && bal.rows[0] ? bal.rows[0].coin_balance : 1000;
            res.json({ reward_multiplier: reward.multiplier, reward_coins: coins, updated_balance: balance, lose_streak: s.loseStreak, daily_win: s.dailyWin, ad });
        } catch(e) {
            console.log('轉轉金幣結算失敗:', e.message);
            res.json({ reward_multiplier: reward.multiplier, reward_coins: coins, updated_balance: 1000 + s.totalWin - s.totalBet, lose_streak: s.loseStreak, daily_win: s.dailyWin, ad });
        }
    } else {
        res.json({ reward_multiplier: reward.multiplier, reward_coins: coins, updated_balance: 1000 + s.totalWin - s.totalBet, lose_streak: s.loseStreak, daily_win: s.dailyWin, ad });
    }
    // When coinDbAvailable is false but not LOCAL_TEST_MODE, still return data but don't save
    if (!coinDbAvailable && !COIN_LOCAL_TEST_MODE) {
        res.json({ reward_multiplier: reward.multiplier, reward_coins: coins, updated_balance: 1000 + s.totalWin - s.totalBet, lose_streak: s.loseStreak, daily_win: s.dailyWin, ad });
    }
});

app.get('/api/coin/balance', async (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.json({ error: 'user_id required' });
    const s = getCoinSession(user_id);
    res.json({ user_id, balance: 1000 + s.totalWin - s.totalBet, total_bet: s.totalBet, total_win: s.totalWin, pulls: s.pulls, lose_streak: s.loseStreak });
});

app.get('/api/coin/admin/stats', async (req, res) => {
    if (COIN_LOCAL_TEST_MODE || !coinDbAvailable) return res.json({ success: true, stats: [] });
    try {
        const result = await coinDb.execute({ sql: `SELECT username, total_bets, total_wins, total_losses, total_win_amount, total_lose_amount FROM coin_player_stats ORDER BY total_bets DESC` });
        res.json({ success: true, stats: result.rows || [] });
    } catch(e) { res.json({ success: false, message: e.message }); }
});
