const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');
const crypto  = require('crypto');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

/* ── helpers ── */
function uid()  { return crypto.randomBytes(8).toString('hex'); }
function genCode() {
  let c;
  do { c = (1000 + Math.floor(Math.random() * 9000)).toString(); } while (rooms[c]);
  return c;
}

/* ── rooms store ── */
const rooms = {};   // code -> { host, clients[], videoUrl, link }

/* ── broadcast helpers ── */
function send(ws, obj)          { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function bcast(room, obj, skip) { room.clients.forEach(c => { if (c !== skip) send(c, obj); }); }
function bcastAll(room, obj)    { room.clients.forEach(c => send(c, obj)); }

/* ── clean up when client disconnects ── */
function remove(ws) {
  const code = ws.roomCode;
  if (!code || !rooms[code]) return;
  const room = rooms[code];
  room.clients = room.clients.filter(c => c !== ws);

  if (room.host === ws && room.clients.length) {
    const next = room.clients[0];
    room.host  = next;
    next.isHost = true;
    send(next, { type: 'host_granted' });
    bcast(room, { type: 'system', text: next.userName + ' стал хостом' });
  }
  bcastAll(room, { type: 'user_left',       name:  ws.userName, count: room.clients.length });
  bcastAll(room, { type: 'viewers_update',  count: room.clients.length });
  if (!room.clients.length) delete rooms[code];
}

/* ── heartbeat ── */
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.alive) { remove(ws); return ws.terminate(); }
    ws.alive = false;
    ws.ping();
  });
}, 25000);

/* ── connection ── */
wss.on('connection', (ws, req) => {
  ws.alive  = true;
  ws.cid    = uid();          // unique connection id
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', raw => {
    let d;
    try { d = JSON.parse(raw); } catch { return; }

    /* CREATE */
    if (d.type === 'create') {
      const code  = genCode();
      const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      const host  = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
      const link  = proto + '://' + host + '/?join=' + code;
      ws.roomCode = code;
      ws.userName = String(d.name || 'Аноним').slice(0, 30);
      ws.isHost   = true;
      rooms[code] = { host: ws, clients: [ws], videoUrl: null, link };
      send(ws, { type: 'room_created', code, link, cid: ws.cid });
      return;
    }

    /* JOIN */
    if (d.type === 'join') {
      const code = String(d.code || '').trim();
      const room = rooms[code];
      if (!room)               return send(ws, { type: 'error', message: 'Комната не найдена' });
      if (room.clients.length >= 50) return send(ws, { type: 'error', message: 'Комната переполнена' });
      ws.roomCode = code;
      ws.userName = String(d.name || 'Аноним').slice(0, 30);
      ws.isHost   = false;
      room.clients.push(ws);
      send(ws, { type: 'joined', code, cid: ws.cid, isHost: false,
                 videoUrl: room.videoUrl, count: room.clients.length, link: room.link });
      bcast(room, { type: 'user_joined',    name: ws.userName, count: room.clients.length }, ws);
      bcastAll(room, { type: 'viewers_update', count: room.clients.length });
      return;
    }

    const room = ws.roomCode ? rooms[ws.roomCode] : null;
    if (!room) return;

    /* HOST-ONLY actions */
    if (d.type === 'load_video') {
      if (!ws.isHost) return;
      room.videoUrl = d.url;
      bcastAll(room, { type: 'load_video', url: d.url });
      return;
    }
    if (d.type === 'play')  { if (!ws.isHost) return; bcast(room, { type:'play',  time: d.time||0 }, ws); return; }
    if (d.type === 'pause') { if (!ws.isHost) return; bcast(room, { type:'pause', time: d.time||0 }, ws); return; }
    if (d.type === 'seek')  { if (!ws.isHost) return; bcast(room, { type:'seek',  time: d.time||0 }, ws); return; }

    /* CHAT — server stamps senderId so client can detect own messages */
    if (d.type === 'chat') {
      const text  = String(d.text  || '').trim().slice(0, 500);
      const image = d.image || null;
      if (!text && !image) return;
      const msgId = uid();
      const msg   = { type: 'chat', text, image, sender: ws.userName,
                      ava: d.ava || '', senderId: ws.cid, msgId };
      bcastAll(room, msg);   // everyone gets it with senderId; client compares with own cid
      return;
    }

    if (d.type === 'reaction') {
      bcastAll(room, { type: 'reaction', msgId: d.msgId, emoji: d.emoji });
      return;
    }

    if (d.type === 'ping') { send(ws, { type: 'pong' }); return; }
  });

  ws.on('close', () => remove(ws));
  ws.on('error', e => { console.error('ws err:', e.message); remove(ws); });
});

/* ── graceful shutdown ── */
function shutdown() {
  wss.clients.forEach(ws => ws.close());
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 4000);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('QvorStream on :' + PORT));
