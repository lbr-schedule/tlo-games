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
    BETTING_TIME: 10000
};

// 骰子遊戲邏輯
function getDiceColor(num) {
    if (num <= 2) return '#ff6b6b';
    if (num <= 4) return '#ffd93d';
    return '#6bcb77';
}

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
    wss.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN && ws.gameType === 'roulette') {
            ws.send(JSON.stringify(msg));
        }
    });
}

function startRouletteBetting() {
    rouletteState.gamePhase = 'betting';
    rouletteState.currentBets = [];
    broadcastRoulette({ type: 'betting_start', duration: rouletteState.BETTING_TIME });
    setTimeout(spinRouletteWheel, rouletteState.BETTING_TIME);
}

function spinRouletteWheel() {
    rouletteState.gamePhase = 'spinning';
    const result = Math.floor(Math.random() * 37);
    rouletteState.lastResult = { result, color: getRouletteColor(result) };
    broadcastRoulette({ type: 'spinning', result });
    setTimeout(() => showRouletteResult(result, rouletteState.lastResult.color), 3000);
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
    setTimeout(startRouletteBetting, 5000);
}

// 升級 HTTP 請求處理
app.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    
    if (pathname === '/roulette' || pathname === '/roulette/ws') {
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
});

// 骰子遊戲訊息處理
function handleDiceMessage(ws, msg) {
    const username = msg.username || 'Player';

    if (msg.type === 'join') {
        // 配對玩家
        const opponent = getNextDiceOpponent(username);
        
        if (opponent) {
            // 找到對手，開始遊戲
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
            // 等待中
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
        
        // 3回合後結束
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
        
        // 重建新遊戲
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
        ws._balance = 1000;
        ws._username = username;
        ws.send(JSON.stringify({ type: 'joined', balance: ws._balance, phase: rouletteState.gamePhase, result: rouletteState.lastResult }));
        if (rouletteState.gamePhase === 'idle') startRouletteBetting();
    }

    if (msg.type === 'bet' && rouletteState.gamePhase === 'betting') {
        rouletteState.currentBets.push({
            username,
            balance: ws._balance,
            type: msg.betType,
            amount: parseInt(msg.amount),
            color: msg.color,
            choice: msg.choice,
            number: msg.number
        });
        broadcastRoulette({ type: 'bets_update', bets: rouletteState.currentBets });
    }
}

// 靜態檔案
app.use('/dice', express.static(path.join(__dirname, 'public/dice')));
app.use('/roulette', express.static(path.join(__dirname, 'public/roulette')));

// 首頁導向骰子遊戲
app.get('/', (req, res) => {
    res.redirect('/dice');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎮 T-LO 遊戲大廳已啟動!`);
    console.log(`   骰子遊戲: http://localhost:${PORT}/dice`);
    console.log(`   俄羅斯輪盤: http://localhost:${PORT}/roulette`);
});