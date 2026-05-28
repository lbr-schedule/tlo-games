const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, '..', 'public')));

// 遊戲狀態
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

    broadcast({ type: 'result', result, color, winners, losers });
    setTimeout(startBetting, 5000);
}

wss.on('connection', (ws) => {
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            const username = msg.username || 'Player';

            if (msg.type === 'join') {
                ws._balance = 1000;
                ws._username = username;
                ws._profile = msg.profile || {};
                console.log('玩家加入:', username, '| 姓名:', ws._profile.realname || '-', '| 電話:', ws._profile.phone || '-', '| 信箱:', ws._profile.email || '-');
                broadcast({ type: 'joined', balance: ws._balance, phase: gamePhase, result: lastResult });
                if (gamePhase === 'idle') startBetting();
            }

            if (msg.type === 'bet' && gamePhase === 'betting') {
                currentBets.push({
                    username,
                    balance: ws._balance,
                    type: msg.betType,
                    amount: parseInt(msg.amount),
                    color: msg.color,
                    choice: msg.choice,
                    number: msg.number
                });
                broadcast({ type: 'bets_update', bets: currentBets });
            }
        } catch(e) { console.log('Error:', e.message); }
    });
});

console.log('🎰 T-LO 俄羅斯輪盤 http://localhost:3001');
server.listen(3001);