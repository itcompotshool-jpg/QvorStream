const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function broadcast(room, data, skipWs) {
    const msg = JSON.stringify(data);
    room.clients.forEach(client => {
        if (client !== skipWs && client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

function getRoomUsers(room) {
    return room.clients.map(c => c.userName);
}

wss.on('connection', (ws) => {
    ws.clientId = Math.random().toString(36).substr(2, 9);

    ws.on('message', (message) => {
        const d = JSON.parse(message);

        if (d.type === 'create') {
            const code = Math.floor(1000 + Math.random() * 9000).toString();
            ws.userName = d.name;
            ws.roomCode = code;
            ws.isHost = true;
            rooms[code] = { clients: [ws], videoUrl: '' };
            ws.send(JSON.stringify({ type: 'room_created', code, clientId: ws.clientId, users: [d.name] }));
        }

        if (d.type === 'join') {
            const room = rooms[d.code];
            if (room) {
                ws.userName = d.name;
                ws.roomCode = d.code;
                ws.isHost = false;
                room.clients.push(ws);
                ws.send(JSON.stringify({ 
                    type: 'joined', 
                    code: d.code, 
                    clientId: ws.clientId, 
                    videoUrl: room.videoUrl,
                    users: getRoomUsers(room)
                }));
                broadcast(room, { type: 'user_update', users: getRoomUsers(room) });
            } else {
                ws.send(JSON.stringify({ type: 'error', msg: 'Комната не найдена' }));
            }
        }

        const currentRoom = rooms[ws.roomCode];
        if (!currentRoom) return;

        // Пересылка видео и команд синхронизации (только от хоста)
        if (d.type === 'set_video' && ws.isHost) {
            currentRoom.videoUrl = d.url;
            broadcast(currentRoom, { type: 'set_video', url: d.url }, ws);
        }

        if (['play', 'pause', 'seek'].includes(d.type) && ws.isHost) {
            broadcast(currentRoom, d, ws);
        }

        if (d.type === 'chat') {
            broadcast(currentRoom, { 
                type: 'chat', 
                text: d.text, 
                sender: ws.userName, 
                clientId: ws.clientId 
            });
        }
    });

    ws.on('close', () => {
        const room = rooms[ws.roomCode];
        if (room) {
            room.clients = room.clients.filter(c => c !== ws);
            if (room.clients.length === 0) {
                delete rooms[ws.roomCode];
            } else {
                broadcast(room, { type: 'user_update', users: getRoomUsers(room) });
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
