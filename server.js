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

// 骰子遊戲用 WebSocket
const WebSocket = require('ws');
const diceWss = new WebSocket.Server({ noServer: true });
const diceState = {
    waitingPlayers: [],
    games: new Map(),
    players: new Map()
};

// 輪盤遊戲狀態（單人，無需 WebSocket）
let rouletteState = {
    phase: 'waiting', // waiting, betting, spinning, result
    result: null,
    lastSpin: null,
    spinTimer: null,
    betTimer: null,
    BETTING_TIME: 10000,
    phaseStartTime: 0,
    hasPlayer: false
};

// ========== 骰子遊戲邏輯 ==========
function createDiceGame(player1, player2) {
    return {
        id: Date.now(),
        players: [player1, player2],
        scores: [0, 0],
        currentTurn: 0,
        status: 'playing',
        round: 1
    };
}

function broadcastDice(msg) {
    for (const [name, data] of diceState.players) {
        if (data.ws.readyState === WebSocket.OPEN) {
            data.ws.send(JSON.stringify(msg));
        }
    }
}

function handleDiceMessage(ws, msg) {
    const username = msg.username || 'Player';

    if (msg.type === 'join') {
        const opponent = diceState.waitingPlayers.find(p => p !== username);
        
        if (opponent) {
            const game = createDiceGame(username, opponent);
            diceState.games.set(game.id, game);
            diceState.waitingPlayers = diceState.waitingPlayers.filter(p => p !== opponent);
            
            const opponentWs = diceState.players.get(opponent)?.ws;
            if (opponentWs) {
                opponentWs.send(JSON.stringify({ type: 'game_start', opponent: username, gameId: game.id, myIndex: 1 }));
            }
            
            ws.send(JSON.stringify({ type: 'game_start', opponent: opponent, gameId: game.id, myIndex: 0 }));
            diceState.players.set(username, { ws, gameId: game.id });
        } else {
            if (!diceState.waitingPlayers.includes(username)) {
                diceState.waitingPlayers.push(username);
            }
            ws.send(JSON.stringify({ type: 'waiting', message: '等待對手中...' }));
            diceState.players.set(username, { ws, gameId: null });
        }
    }
    
    if (msg.type === 'roll') {
        const player = diceState.players.get(username);
        if (!player?.gameId) return;
        
        const game = diceState.games.get(player.gameId);
        if (!game || game.status !== 'playing') return;
        
        const playerIndex = game.players.indexOf(username);
        if (playerIndex !== game.currentTurn) return;
        
        // 如果是老闆帳號(12345)，使用加權骰子給予約70%勝率
        let dice;
        if (username === '12345') {
            // 75%機會骰到5-6，25%機會骰到1-4
            dice = Math.random() < 0.75 ? Math.floor(Math.random() * 2) + 5 : Math.floor(Math.random() * 4) + 1;
        } else {
            dice = Math.floor(Math.random() * 6) + 1;
        }
        game.scores[playerIndex] += dice;
        
        broadcastDice({
            type: 'roll_result',
            player: username,
            dice,
            scores: game.scores,
            nextTurn: game.currentTurn
        });
        
        if (game.round >= 3) {
            game.status = 'finished';
            const winner = game.scores[0] > game.scores[1] ? 0 : (game.scores[1] > game.scores[0] ? 1 : -1);
            broadcastDice({
                type: 'game_over',
                scores: game.scores,
                winner: winner >= 0 ? game.players[winner] : null,
                isDraw: winner === -1
            });
        } else {
            game.round++;
            game.currentTurn = 1 - game.currentTurn;
        }
    }
    
    if (msg.type === 'rematch') {
        const player = diceState.players.get(username);
        if (!player?.gameId) return;
        
        const game = diceState.games.get(player.gameId);
        if (!game || game.status !== 'finished') return;
        
        const newGame = createDiceGame(game.players[0], game.players[1]);
        diceState.games.set(newGame.id, newGame);
        diceState.games.delete(game.id);
        
        for (const p of game.players) {
            const pData = diceState.players.get(p);
            if (pData) pData.gameId = newGame.id;
            const pWs = diceState.players.get(p)?.ws;
            if (pWs) pWs.send(JSON.stringify({ type: 'game_start', opponent: game.players[1 - game.players.indexOf(p)], gameId: newGame.id, myIndex: game.players.indexOf(p) }));
        }
    }
}

diceWss.on('connection', (ws) => {
    ws.on('message', (data) => {
        try {
            handleDiceMessage(ws, JSON.parse(data));
        } catch(e) { console.log('Dice error:', e.message); }
    });
});

// ========== 輪盤遊戲邏輯（無 WebSocket） ==========
function getRouletteColor(num) {
    if (num === 0) return 'green';
    const reds = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
    return reds.includes(num) ? 'red' : 'black';
}

function spinWheel() {
    rouletteState.phase = 'spinning';
    
    // 真正的隨機轉盤结果（0-36，均等概率）
    // 庄家優勢體現在：0幾乎必定虧損（顏色投注必定輸）
    // 真實輪盤：0 green, 18 red, 18 black → 庄家在顏色投注時有2.7%基本優勢
    // 加上顏色不平衡時的額外優勢，我們採用真實比例但稍微調整
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
    
    // 純隨機選擇（每個數字均等概率）
    const selectedIndex = Math.floor(Math.random() * 37);
    const selected = allNumbers[selectedIndex];
    
    // 庄家優勢實現：當結果是0時幾乎所有下注都輸
    // 真實輪盤機率：P(0)=1/37≈2.7%, P(red)=18/37≈48.6%, P(black)=18/37≈48.6%
    // 這導致顏色下注時庄家優勢為 2.7%（真實比例）
    
    rouletteState.lastSpin = { 
        result: selected.num, 
        color: selected.color, 
        time: Date.now() 
    };
    
    // HTTP輪詢模式不需要廣播，等待12秒後進入結果（配合前端動畫，結果多看5秒）
    setTimeout(() => {
        rouletteState.phase = 'result';
        // 12秒後自動開始下一局
        rouletteState.spinTimer = setTimeout(startBetting, 12000);
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

// JSON 解析（必須在路由之前）
app.use(express.json());

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
        
        // 加入 timeout 防止永久等待
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('資料庫操作超時')), 5000);
        });
        
        const executePromise = rouletteDb.execute({
            sql: `INSERT INTO players (username, password, score) VALUES (?, ?, 1000)`,
            args: [username, password]
        });
        
        const result = await Promise.race([executePromise, timeoutPromise]);
        console.log('註冊成功, result:', JSON.stringify(result));
        res.json({ success: true, message: '註冊成功！' });
    } catch(e) {
        console.log('註冊失敗, error:', e.message);
        res.json({ success: false, message: '帳號已存在' });
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

// ========== HTTP 路由 ==========
app.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    
    if (url.pathname === '/dice/ws') {
        diceWss.handleUpgrade(request, socket, head, (ws) => {
            diceWss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
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