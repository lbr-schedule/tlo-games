const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

let gamePhase = 'idle';
let currentBets = [];
let lastResult = null;
const BETTING_TIME = 10000;

function getColor(num) {
    if (num === 0) return 'green';
    const reds = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
    return reds.includes(num) ? 'red' : 'black';
}

function broadcast(msg) {
    wss.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    });
}

function startBetting() {
    gamePhase = 'betting';
    currentBets = [];
    broadcast({ type: 'betting_start', duration: BETTING_TIME });
    setTimeout(spinWheel, BETTING_TIME);
}

function spinWheel() {
    gamePhase = 'spinning';
    const result = Math.floor(Math.random() * 37);
    lastResult = { result, color: getColor(result) };
    broadcast({ type: 'spinning', result });
    setTimeout(() => showResult(result, lastResult.color), 3000);
}

function showResult(result, color) {
    gamePhase = 'result';
    const winners = [];
    const losers = [];

    for (const bet of currentBets) {
        if (bet.type === 'straight' && bet.number === result) {
            winners.push({ player: bet.player, amount: bet.amount * 35 });
        } else if (bet.type === 'color' && bet.color === color) {
            winners.push({ player: bet.player, amount: bet.amount * 2 });
        } else {
            losers.push({ player: bet.player, amount: bet.amount });
        }
    }

    broadcast({ type: 'result', result, color, winners, losers });
    currentBets = [];
    setTimeout(startBetting, 5000);
}

wss.on('connection', (ws) => {
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            if (gamePhase === 'betting') {
                if (message.type === 'bet') {
                    currentBets.push({
                        player: message.player,
                        type: message.betType,
                        color: message.color,
                        number: message.number,
                        amount: message.amount
                    });
                    ws.send(JSON.stringify({ type: 'bet_confirmed', bet: message }));
                    broadcast({ type: 'bets_update', bets: currentBets });
                }
            } else if (message.type === 'join') {
                ws.send(JSON.stringify({ type: 'game_state', phase: gamePhase, lastResult }));
            }
        } catch(e) { console.log('Error:', e.message); }
    });
});

server.listen(PORT, () => {
    console.log('🎰 T-LO 俄羅斯輪盤 http://localhost:' + PORT);
});
