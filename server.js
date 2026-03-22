const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ status: 'ok', rooms: Object.keys(rooms).length }));

const rooms = {};

function genCode() {
    let c;
    do { c = Math.floor(1000 + Math.random() * 9000).toString(); } while (rooms[c]);
    return c;
}

function genId() {
    return crypto.randomBytes(8).toString('hex');
}

function broadcast(room, data, exclude = null) {
    const msg = JSON.stringify(data);
    room.clients.forEach(c => {
        if (c !== exclude && c.readyState === WebSocket.OPEN) c.send(msg);
    });
}

function broadcastAll(room, data) {
    const msg = JSON.stringify(data);
    room.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(msg);
    });
}

function removeClient(ws) {
    const code = ws.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    room.clients = room.clients.filter(c => c !== ws);

    if (room.host === ws && room.clients.length > 0) {
        room.host = room.clients[0];
        room.clients[0].isHost = true;
        room.clients[0].send(JSON.stringify({ type: 'host_granted' }));
        broadcast(room, { type: 'system', text: room.clients[0].userName + ' стал хостом' });
    }

    broadcast(room, { type: 'user_left', name: ws.userName || 'Аноним', count: room.clients.length });
    broadcastAll(room, { type: 'viewers_update', count: room.clients.length });
    if (room.clients.length === 0) { delete rooms[code]; }
}

// Heartbeat
const hbTimer = setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) { removeClient(ws); return ws.terminate(); }
        ws.isAlive = false;
        ws.ping();
    });
}, 25000);
wss.on('close', () => clearInterval(hbTimer));

wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.clientId = genId(); // unique ID for this connection
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        let data;
        try { data = JSON.parse(raw); } catch { return; }
        const { type } = data;

        if (type === 'create') {
            const code = genCode();
            const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
            const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
            const link = `${proto}://${host}/?join=${code}`;
            ws.roomCode = code;
            ws.userName = (data.name || 'Аноним').slice(0, 30);
            ws.isHost = true;
            rooms[code] = { host: ws, clients: [ws], videoUrl: null, link };
            // Send clientId so client knows who they are
            ws.send(JSON.stringify({ type: 'room_created', code, link, isHost: true, clientId: ws.clientId }));
            return;
        }

        if (type === 'join') {
            const code = String(data.code || '').trim();
            const room = rooms[code];
            if (!room) return ws.send(JSON.stringify({ type: 'error', message: 'Комната не найдена' }));
            if (room.clients.length >= 50) return ws.send(JSON.stringify({ type: 'error', message: 'Комната переполнена' }));
            ws.roomCode = code;
            ws.userName = (data.name || 'Аноним').slice(0, 30);
            ws.isHost = false;
            room.clients.push(ws);
            // Send clientId so client knows who they are
            ws.send(JSON.stringify({
                type: 'joined', code, isHost: false,
                videoUrl: room.videoUrl, count: room.clients.length,
                link: room.link, clientId: ws.clientId
            }));
            broadcast(room, { type: 'user_joined', name: ws.userName, count: room.clients.length }, ws);
            broadcastAll(room, { type: 'viewers_update', count: room.clients.length });
            return;
        }

        const room = ws.roomCode ? rooms[ws.roomCode] : null;
        if (!room) return;

        if (type === 'load_video') {
            if (!ws.isHost) return;
            room.videoUrl = data.url;
            broadcastAll(room, { type: 'load_video', url: data.url });
            return;
        }
        if (type === 'play')  { if (!ws.isHost) return; broadcast(room, { type: 'play',  time: data.time }, ws); return; }
        if (type === 'pause') { if (!ws.isHost) return; broadcast(room, { type: 'pause', time: data.time }, ws); return; }
        if (type === 'seek')  { if (!ws.isHost) return; broadcast(room, { type: 'seek',  time: data.time }, ws); return; }

        if (type === 'chat') {
            const text = String(data.text || '').trim().slice(0, 500);
            if (!text && !data.imageData) return;
            // Include senderId so each client can tell if it's their own message
            // Use client-provided msgId if valid, else generate one
            const msgId = (typeof data.msgId === 'string' && data.msgId.length < 80)
                ? data.msgId : genId();
            const msg = {
                type: 'chat',
                text: text || '',
                imageData: data.imageData || null,
                sender: ws.userName,
                senderId: ws.clientId,   // server-assigned unique ID
                ava: data.ava || '',
                msgId                    // preserved from client so _myMsgSet works
            };
            // Send to everyone — client checks senderId OR msgId to determine ownership
            broadcastAll(room, msg);
            return;
        }

        if (type === 'reaction') {
            broadcastAll(room, { type: 'reaction', msgId: data.msgId, emoji: data.emoji, user: ws.userName });
            return;
        }
        if (type === 'ping_room') { ws.send(JSON.stringify({ type: 'pong_room' })); return; }
    });

    ws.on('close', () => removeClient(ws));
    ws.on('error', (e) => { console.error('WS:', e.message); removeClient(ws); });
});

function shutdown() {
    clearInterval(hbTimer);
    wss.clients.forEach(ws => ws.close(1001, 'shutdown'));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('QvorStream :' + PORT));
