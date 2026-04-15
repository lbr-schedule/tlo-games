const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);

// ====== 統一 WebSocket 路由 ======
const wss = new WebSocket.Server({ noServer: true });

// 骰子遊戲狀態
const diceState = {
    waitingPlayers: [],
    games: new Map(),
    players: new Map()
};

// 輪盤遊戲狀態
const rouletteState = {
    gamePhase: 'idle',
    currentBets: [],
    lastResult: null,
    players: new Map(), // username -> ws
    BETTING_TIME: 10000,
    spinTimer: null
};

// 骰子遊戲邏輯
function createDiceGame(player1, player2) {
    return {
        id: Date.now(),
        players: [player1, player2],
        scores: [0, 0],
        currentTurn: 0,
        status: 'playing',
        phase: 'roll',
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

function getNextDiceOpponent(excludeName) {
    const available = diceState.waitingPlayers.filter(p => p !== excludeName);
    return available[0] || null;
}

// 輪盤遊戲邏輯
function getRouletteColor(num) {
    if (num === 0) return 'green';
    const reds = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
    return reds.includes(num) ? 'red' : 'black';
}

function broadcastRoulette(msg) {
    for (const [username, ws] of rouletteState.players) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }
}

function getOnlinePlayers() {
    return Array.from(rouletteState.players.keys());
}

function startRouletteBetting() {
    rouletteState.gamePhase = 'betting';
    rouletteState.currentBets = [];
    broadcastRoulette({ type: 'betting_start', duration: rouletteState.BETTING_TIME });
    rouletteState.spinTimer = setTimeout(spinRouletteWheel, rouletteState.BETTING_TIME);
}

function spinRouletteWheel() {
    rouletteState.gamePhase = 'spinning';
    const result = Math.floor(Math.random() * 37);
    rouletteState.lastResult = { result, color: getRouletteColor(result) };
    broadcastRoulette({ type: 'spinning', result });
    rouletteState.spinTimer = setTimeout(() => showRouletteResult(result, rouletteState.lastResult.color), 3000);
}

function showRouletteResult(result, color) {
    rouletteState.gamePhase = 'result';
    const winners = [];
    const losers = [];

    for (const bet of rouletteState.currentBets) {
        let win = false;
        if (bet.type === 'color' && bet.color === color) win = true;
        if (bet.type === 'odd_even') {
            if (bet.choice === 'odd' && result % 2 === 1 && result !== 0) win = true;
            if (bet.choice === 'even' && result % 2 === 0 && result !== 0) win = true;
        }
        if (bet.type === 'number' && bet.number === result) win = true;

        if (win) {
            const prize = bet.type === 'number' ? bet.amount * 10 : bet.amount * 2;
            bet.balance += prize;
            winners.push({ username: bet.username, amount: bet.amount, prize });
        } else {
            bet.balance -= bet.amount;
            losers.push({ username: bet.username, amount: bet.amount });
        }
    }

    broadcastRoulette({ type: 'result', result, color, winners, losers });
    
    // 5秒後開始下一局（只有有玩家在線才繼續）
    if (rouletteState.players.size > 0) {
        rouletteState.spinTimer = setTimeout(startRouletteBetting, 5000);
    } else {
        rouletteState.gamePhase = 'idle';
    }
}

// 停止輪盤遊戲
function stopRouletteGame() {
    if (rouletteState.spinTimer) {
        clearTimeout(rouletteState.spinTimer);
        rouletteState.spinTimer = null;
    }
    rouletteState.gamePhase = 'idle';
    rouletteState.currentBets = [];
}

// HTTP 升級處理
app.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, 'http://' + request.headers.host).pathname;
    console.log('WS upgrade request:', pathname);
    
    if (pathname === '/roulette/ws' || pathname === '/ws/roulette') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            ws.gameType = 'roulette';
            wss.emit('connection', ws, request);
        });
    } else {
        // 骰子遊戲
        wss.handleUpgrade(request, socket, head, (ws) => {
            ws.gameType = 'dice';
            wss.emit('connection', ws, request);
        });
    }
});

// WebSocket 處理
wss.on('connection', (ws) => {
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            
            if (ws.gameType === 'dice') {
                handleDiceMessage(ws, msg);
            } else if (ws.gameType === 'roulette') {
                handleRouletteMessage(ws, msg);
            }
        } catch(e) { console.log('Error:', e.message); }
    });
    
    ws.on('close', () => {
        if (ws.gameType === 'roulette' && ws._username) {
            rouletteState.players.delete(ws._username);
            broadcastRoulette({ type: 'players_update', players: getOnlinePlayers() });
            
            // 如果沒有玩家了，停止遊戲
            if (rouletteState.players.size === 0) {
                stopRouletteGame();
            }
        }
    });
});

// 骰子遊戲訊息處理
function handleDiceMessage(ws, msg) {
    const username = msg.username || 'Player';

    if (msg.type === 'join') {
        const opponent = getNextDiceOpponent(username);
        
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

// 輪盤遊戲訊息處理
function handleRouletteMessage(ws, msg) {
    const username = msg.username || 'Player';

    if (msg.type === 'join') {
        ws._username = username;
        ws._balance = 1000;
        rouletteState.players.set(username, ws);
        
        // 發送歡迎訊息和當前狀態
        ws.send(JSON.stringify({ 
            type: 'joined', 
            balance: ws._balance, 
            phase: rouletteState.gamePhase,
            result: rouletteState.lastResult,
            players: getOnlinePlayers()
        }));
        
        // 廣播玩家列表
        broadcastRoulette({ type: 'players_update', players: getOnlinePlayers() });
        
        // 如果遊戲閒置，開始新遊戲
        if (rouletteState.gamePhase === 'idle') {
            startRouletteBetting();
        }
    }

    if (msg.type === 'bet' && rouletteState.gamePhase === 'betting') {
        // 檢查玩家是否已下注
        const existingBet = rouletteState.currentBets.find(b => b.username === username);
        if (existingBet) {
            ws.send(JSON.stringify({ type: 'error', message: '你已經下注了！' }));
            return;
        }
        
        rouletteState.currentBets.push({
            username,
            balance: ws._balance,
            type: msg.betType,
            amount: parseInt(msg.amount),
            color: msg.color,
            choice: msg.choice,
            number: msg.number
        });
        
        ws.send(JSON.stringify({ type: 'bet_confirmed', bets: rouletteState.currentBets.filter(b => b.username === username) }));
    }
}

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
                    <p>單人/多人對戰</p>
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