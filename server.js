const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        const data = JSON.parse(message);
        if (data.type === 'create') {
            const code = Math.floor(1000 + Math.random() * 9000).toString();
            rooms[code] = { host: ws, clients: [ws], videoUrl: null };
            ws.roomCode = code;
            ws.send(JSON.stringify({ type: 'room_created', code: code }));
        } else if (data.type === 'join') {
            const room = rooms[data.code];
            if (room) {
                room.clients.push(ws);
                ws.roomCode = data.code;
                ws.send(JSON.stringify({ type: 'joined', code: data.code, videoUrl: room.videoUrl }));
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'Комната не найдена' }));
            }
        } else if (ws.roomCode && rooms[ws.roomCode]) {
            const room = rooms[ws.roomCode];
            if (data.type === 'load_video') room.videoUrl = data.url;
            room.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
            });
        }
    });
});

server.listen(3000, () => console.log('🚀 Quorvox запущен на порту 3000'));
