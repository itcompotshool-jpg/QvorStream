const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

// Функция для генерации ID сообщения
function generateMessageId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

function broadcast(room, data, skipWs) {
    const msg = JSON.stringify(data);
    room.clients.forEach(client => {
        if (client !== skipWs && client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

function getRoomUsers(room) {
    return room.clients.map(c => ({ 
        name: c.userName, 
        avatar: c.avatar,
        isHost: c.isHost,
        clientId: c.clientId 
    }));
}

wss.on('connection', (ws) => {
    ws.clientId = Math.random().toString(36).substr(2, 9);

    ws.on('message', (message) => {
        const d = JSON.parse(message);

        if (d.type === 'create') {
            const code = Math.floor(1000 + Math.random() * 9000).toString();
            ws.userName = d.name;
            ws.avatar = d.avatar || '👤';
            ws.roomCode = code;
            ws.isHost = true;
            
            // Инициализируем хранилище для сообщений и реакций
            rooms[code] = { 
                clients: [ws], 
                videoUrl: '', 
                messages: [],
                reactions: new Map()
            };
            
            ws.send(JSON.stringify({ 
                type: 'room_created', 
                code, 
                clientId: ws.clientId, 
                users: getRoomUsers(rooms[code]),
                videoUrl: ''
            }));
        }

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
                    users: getRoomUsers(room)
                }));
                
                broadcast(room, { type: 'users', users: getRoomUsers(room) });
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

        // Обычный чат
        if (d.type === 'chat') {
            const messageData = { 
                type: 'chat', 
                text: d.text, 
                sender: ws.userName, 
                avatar: ws.avatar,
                clientId: ws.clientId,
                time: d.time || new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
            };
            
            // Сохраняем сообщение в истории
            const messageObj = {
                id: generateMessageId(),
                text: d.text,
                sender: ws.userName,
                avatar: ws.avatar,
                clientId: ws.clientId,
                time: messageData.time
            };
            
            if (!currentRoom.messages) currentRoom.messages = [];
            currentRoom.messages.push(messageObj);
            
            broadcast(currentRoom, messageData);
        }
        
        // Ответ на сообщение
        if (d.type === 'reply') {
            // Находим сообщение, на которое отвечают
            const replyToMessage = currentRoom.messages?.find(m => m.id === d.replyToId);
            
            const newMessage = {
                id: generateMessageId(),
                text: d.text,
                sender: ws.userName,
                avatar: ws.avatar,
                clientId: ws.clientId,
                time: d.time || new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
                replyTo: replyToMessage ? {
                    id: replyToMessage.id,
                    text: replyToMessage.text.substring(0, 80) + (replyToMessage.text.length > 80 ? '...' : ''),
                    sender: replyToMessage.sender
                } : null
            };
            
            // Сохраняем в историю
            if (!currentRoom.messages) currentRoom.messages = [];
            currentRoom.messages.push(newMessage);
            
            // Рассылаем всем
            broadcast(currentRoom, {
                type: 'new_message',
                message: newMessage
            });
        }
        
        // Обработка реакций (лайков)
        if (d.type === 'reaction') {
            if (!currentRoom.reactions) currentRoom.reactions = new Map();
            
            let messageReactions = currentRoom.reactions.get(d.messageId) || { likes: new Set() };
            
            if (d.action === 'add') {
                messageReactions.likes.add(d.clientId);
            } else if (d.action === 'remove') {
                messageReactions.likes.delete(d.clientId);
            }
            
            currentRoom.reactions.set(d.messageId, messageReactions);
            
            // Рассылаем обновление всем в комнате
            broadcast(currentRoom, {
                type: 'reaction_update',
                messageId: d.messageId,
                reactions: {
                    likes: messageReactions.likes.size
                },
                userReacted: messageReactions.likes.has(d.clientId)
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
                broadcast(room, { type: 'users', users: getRoomUsers(room) });
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
