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

try {
    rouletteDb = createClient({
        url: rouletteDbUrl,
        authToken: rouletteDbAuthToken
    });
    console.log('輪盤遊戲 Turso client 已建立');
} catch(e) {
    console.log('輪盤遊戲 Turso client 建立失敗:', e.message);
}

// 測試輪盤資料庫連線
if (rouletteDb) {
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
    phaseStartTime: 0
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
        
        const dice = Math.floor(Math.random() * 6) + 1;
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
    const result = Math.floor(Math.random() * 37);
    rouletteState.lastSpin = { result, color: getRouletteColor(result), time: Date.now() };
    
    // HTTP輪詢模式不需要廣播，等待3秒後進入結果
    setTimeout(() => {
        rouletteState.phase = 'result';
        // 5秒後自動開始下一局
        rouletteState.spinTimer = setTimeout(startBetting, 5000);
    }, 3000);
}

function startBetting() {
    rouletteState.phase = 'betting';
    rouletteState.lastSpin = null; // 清除上一局結果
    rouletteState.currentBets = []; // 清除下注（防範新一局殘留）
    rouletteState.phaseStartTime = Date.now();
    rouletteState.spinTimer = setTimeout(spinWheel, rouletteState.BETTING_TIME);
}

// 初始化輪盤
startBetting();

// 輪盤 API
app.get('/api/roulette/status', (req, res) => {
    let remaining = 0;
    
    if (rouletteState.phase === 'betting') {
        const elapsed = (Date.now() - rouletteState.phaseStartTime) / 1000;
        remaining = Math.max(0, Math.ceil(rouletteState.BETTING_TIME / 1000 - elapsed));
    } else if (rouletteState.phase === 'result') {
        remaining = 5;
    }
    
    res.json({
        phase: rouletteState.phase,
        lastSpin: rouletteState.lastSpin,
        remaining: remaining
    });
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
    if (!rouletteDbAvailable) return res.json({ success: false, message: '伺服器維護中' });
    
    try {
        const result = await rouletteDb.execute({
            sql: `SELECT * FROM players WHERE username = ? AND password = ?`,
            args: [username, password]
        });
        
        if (result.rows && result.rows.length > 0) {
            const row = result.rows[0];
            res.json({ success: true, player: { id: row.id, username: row.username, score: row.score, wins: row.wins || 0, losses: row.losses || 0 } });
        } else {
            res.json({ success: false, message: '帳號或密碼錯誤' });
        }
    } catch(e) {
        res.json({ success: false, message: '登入失敗' });
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

// JSON 解析
app.use(express.json());

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