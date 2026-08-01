const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// раздача стат файлов из публик
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// получения фильмов из basa.json
app.get('/api/movies', (req, res) => {
    try {
        const data = fs.readFileSync(path.join(__dirname, 'basa.json'), 'utf8');
        res.json(JSON.parse(data));
    } catch (err) {
        console.error('Ошибка чтения basa.json:', err);
        res.status(500).json({ error: 'Failed to load movies' });
    }
});

const rooms = {};

// ген ID сообщения
function generateMessageId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

// проверка соообщеня 
function broadcast(room, data, skipWs = null) {
    if (!room || !room.clients) return;
    const msg = JSON.stringify(data);
    room.clients.forEach(client => {
        if (client !== skipWs && client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

// получения списка пользователей в комнате
function getRoomUsers(room) {
    if (!room || !room.clients) return [];
    return room.clients.map(c => ({
        name: c.userName || 'Аноним',
        avatar: c.avatar || '👤',
        isHost: c.isHost,
        clientId: c.clientId
    }));
}

wss.on('connection', (ws) => {
    ws.clientId = Math.random().toString(36).substr(2, 9);
    console.log('Новое подключение:', ws.clientId);

    ws.on('message', (message) => {
        try {
            const d = JSON.parse(message);
            
            // 1. Создание комнаты
            if (d.type === 'create') {
                const code = Math.floor(1000 + Math.random() * 9000).toString();
                ws.userName = d.name;
                ws.avatar = d.avatar || '👤';
                ws.roomCode = code;
                ws.isHost = true;
                
                // ИСПРАВЛЕНО: reactions - это обычный объект {}, а не Map
                rooms[code] = { 
                    clients: [ws], 
                    videoUrl: d.videoUrl || '', 
                    messages: [],
                    reactions: {} 
                };
                
                ws.send(JSON.stringify({ 
                    type: 'room_created', 
                    code, 
                    clientId: ws.clientId, 
                    users: getRoomUsers(rooms[code]),
                    videoUrl: rooms[code].videoUrl,
                    messages: []
                }));
            }
            
            // 2. Присоединение к комнате
            if (d.type === 'join') {
                const room = rooms[d.code];
                if (room) {
                    ws.userName = d.name;
                    ws.avatar = d.avatar || '👤';
                    ws.roomCode = d.code;
                    ws.isHost = false;
                    room.clients.push(ws);
                    
                    ws.send(JSON.stringify({ 
                        type: 'joined', 
                        code: d.code, 
                        clientId: ws.clientId, 
                        videoUrl: room.videoUrl,
                        users: getRoomUsers(room),
                        messages: room.messages || [] // Отправляем историю сообщений новому участнику
                    }));
                    broadcast(room, { type: 'users', users: getRoomUsers(room) });
                } else {
                    ws.send(JSON.stringify({ type: 'error', msg: 'Комната не найдена' }));
                }
            }

            const currentRoom = rooms[ws.roomCode];
            if (!currentRoom) return;

            // 3. Установка видео (только хост)
            if (d.type === 'set_video' && ws.isHost) {
                currentRoom.videoUrl = d.url;
                broadcast(currentRoom, { type: 'set_video', url: d.url });
            }

            // 4. Синхронизация плеера (play, pause, seek)
            if (['play', 'pause', 'seek'].includes(d.type) && ws.isHost) {
                broadcast(currentRoom, d);
            }

            // 5. Обычное сообщение в чат
            if (d.type === 'chat') {
                const messageObj = {
                    id: generateMessageId(),
                    type: 'chat',
                    text: d.text,
                    sender: ws.userName,
                    avatar: ws.avatar,
                    clientId: ws.clientId,
                    time: d.time || new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
                    replyTo: null
                };
                
                currentRoom.messages.push(messageObj);
                // Ограничиваем историю 100 сообщениями для защиты памяти сервера (Render)
                if (currentRoom.messages.length > 100) currentRoom.messages.shift();

                broadcast(currentRoom, { type: 'new_message', message: messageObj });
            }

            // 6. Ответ на сообщение
            if (d.type === 'reply') {
                const replyToMessage = currentRoom.messages.find(m => m.id === d.replyToId);
                const messageObj = {
                    id: generateMessageId(),
                    type: 'reply',
                    text: d.text,
                    sender: ws.userName,
                    avatar: ws.avatar,
                    clientId: ws.clientId,
                    time: d.time || new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
                    replyTo: replyToMessage ? {
                        id: replyToMessage.id,
                        text: replyToMessage.text.substring(0, 60) + (replyToMessage.text.length > 60 ? '...' : ''),
                        sender: replyToMessage.sender
                    } : null
                };
                
                currentRoom.messages.push(messageObj);
                if (currentRoom.messages.length > 100) currentRoom.messages.shift();

                broadcast(currentRoom, { type: 'new_message', message: messageObj });
            }

            // 7. Реакции (ИСПРАВЛЕНО: используем массивы вместо Set)
            if (d.type === 'reaction') {
                if (!currentRoom.reactions[d.messageId]) {
                    currentRoom.reactions[d.messageId] = { likes: [] };
                }
                
                const msgReactions = currentRoom.reactions[d.messageId];
                
                if (d.action === 'add' && !msgReactions.likes.includes(d.clientId)) {
                    msgReactions.likes.push(d.clientId);
                } else if (d.action === 'remove') {
                    msgReactions.likes = msgReactions.likes.filter(id => id !== d.clientId);
                }
                
                broadcast(currentRoom, {
                    type: 'reaction_update',
                    messageId: d.messageId,
                    reactions: { likes: msgReactions.likes.length },
                    userReacted: msgReactions.likes.includes(d.clientId)
                });
            }

        } catch (err) {
            console.error('Ошибка обработки WebSocket сообщения:', err);
        }
    });

    // 8. Отключение пользователя
    ws.on('close', () => {
        const room = rooms[ws.roomCode];
        if (room) {
            room.clients = room.clients.filter(c => c !== ws);
            if (room.clients.length === 0) {
                delete rooms[ws.roomCode]; // Удаляем пустую комнату
            } else {
                broadcast(room, { type: 'users', users: getRoomUsers(room) });
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`QuorStream сервер запущен на порту ${PORT}`);
});
