const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);

// ====== 骰子遊戲 ======
const diceWss = new WebSocket.Server({ noServer: true });
const diceState = {
    waitingPlayers: [],
    games: new Map(),
    players: new Map()
};

// ====== 輪盤遊戲 ======
const rouletteWss = new WebSocket.Server({ noServer: true });
const rouletteState = {
    gamePhase: 'idle',
    currentBets: [],
    lastResult: null,
    players: new Map(),
    BETTING_TIME: 10000,
    spinTimer: null
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

// ========== 輪盤遊戲邏輯 ==========
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
    
    if (rouletteState.players.size > 0) {
        rouletteState.spinTimer = setTimeout(startRouletteBetting, 5000);
    } else {
        rouletteState.gamePhase = 'idle';
    }
}

function handleRouletteMessage(ws, msg) {
    const username = msg.username || 'Player';

    if (msg.type === 'join') {
        ws._username = username;
        ws._balance = 1000;
        rouletteState.players.set(username, ws);
        
        ws.send(JSON.stringify({ 
            type: 'joined', 
            balance: ws._balance, 
            phase: rouletteState.gamePhase,
            result: rouletteState.lastResult,
            players: getOnlinePlayers()
        }));
        
        broadcastRoulette({ type: 'players_update', players: getOnlinePlayers() });
        
        if (rouletteState.gamePhase === 'idle') {
            startRouletteBetting();
        }
    }

    if (msg.type === 'bet' && rouletteState.gamePhase === 'betting') {
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

rouletteWss.on('connection', (ws) => {
    ws.on('message', (data) => {
        try {
            handleRouletteMessage(ws, JSON.parse(data));
        } catch(e) { console.log('Roulette error:', e.message); }
    });
    
    ws.on('close', () => {
        if (ws._username) {
            rouletteState.players.delete(ws._username);
            broadcastRoulette({ type: 'players_update', players: getOnlinePlayers() });
            
            if (rouletteState.players.size === 0) {
                if (rouletteState.spinTimer) {
                    clearTimeout(rouletteState.spinTimer);
                    rouletteState.spinTimer = null;
                }
                rouletteState.gamePhase = 'idle';
            }
        }
    });
});

// ========== HTTP 路由 ==========
// 骰子 WebSocket
app.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    
    if (url.pathname === '/dice/ws') {
        diceWss.handleUpgrade(request, socket, head, (ws) => {
            diceWss.emit('connection', ws, request);
        });
    } else if (url.pathname === '/roulette/ws') {
        rouletteWss.handleUpgrade(request, socket, head, (ws) => {
            rouletteWss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
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