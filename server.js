const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// !!! Запуск на порту 3000 !!!
const PORT = 3000;

// Структура для хранения информации о комнатах
const rooms = {};

// Обслуживание статических файлов из папки 'public'
app.use(express.static(path.join(__dirname, 'public')));

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---

function generateRoomCode() {
    let code;
    do {
        code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (rooms[code]);
    return code;
}

function getRoomByClient(client) {
    for (const code in rooms) {
        if (rooms[code].clients.includes(client)) {
            return rooms[code];
        }
    }
    return null;
}

function broadcast(code, message) {
    const room = rooms[code];
    if (room && room.clients.length > 0) {
        room.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(message));
            }
        });
    }
}

// --- ОБРАБОТЧИК WEBSOCKET ---

wss.on('connection', function connection(ws) {
    console.log('✅ Новое WebSocket соединение установлено.');
    ws.roomCode = null; 
    ws.userName = 'Аноним'; 

    ws.on('message', function incoming(message) {
        let data;
        try {
            data = JSON.parse(message);
            if (data.sender) ws.userName = data.sender;
        } catch (e) {
            console.error("❌ Некорректный JSON:", message.toString());
            return;
        }
        
        const type = data.type;
        const code = data.code;

        if (type === 'create') {
            
            if (ws.roomCode) {
                ws.send(JSON.stringify({ type: 'error', message: 'Вы уже находитесь в комнате.' }));
                return;
            }
            
            const newCode = generateRoomCode();
            rooms[newCode] = {
                host: ws,
                clients: [ws],
                videoUrl: null,
                lastSync: null 
            };
            ws.roomCode = newCode;

            ws.send(JSON.stringify({ type: 'room_created', code: newCode }));
            console.log(`[ROOM] Комната ${newCode} создана пользователем ${ws.userName}.`);

        } else if (type === 'join') {
            
            const room = rooms[code];

            if (room) {
                if (!room.clients.includes(ws)) {
                    room.clients.push(ws);
                    ws.roomCode = code;
                }
                
                // Отправка текущего состояния комнаты
                if (room.videoUrl) {
                    ws.send(JSON.stringify({ 
                        type: 'sync_initial', 
                        code: code,
                        data: { videoUrl: room.videoUrl, lastSync: room.lastSync }
                    }));
                }

                broadcast(code, { type: 'chat', sender: 'System', text: `${data.sender} присоединился к сессии.`, isSystem: true });
                console.log(`[ROOM] ${data.sender} присоединился к комнате ${code}.`);
                
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'Комната не найдена.' }));
            }

        } else if (type === 'load_video' && code) {
            
            const room = rooms[code];
            if (room && room.host === ws) {
                room.videoUrl = data.url;
                room.lastSync = null; 

                broadcast(code, { 
                    type: 'load_video', 
                    sender: data.sender, 
                    url: data.url
                });
                console.log(`[VIDEO] Хост в комнате ${code} загрузил видео.`);

            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'Только хост может загружать видео.' }));
            }
        } else if (type === 'sync' && code) {
            
            const room = rooms[code];
            
            if (room && room.host === ws) {
                room.lastSync = { 
                    action: data.action, 
                    time: data.time 
                };
                
                // Отправляем всем, кроме хоста
                room.clients.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                         client.send(JSON.stringify({ 
                            type: 'sync', 
                            action: data.action, 
                            time: data.time 
                        }));
                    }
                });
            } 
            // Не отправляем ошибку, если не хост, чтобы не спамить консоль
        } else if (type === 'chat' && code) {
            
            broadcast(code, { 
                type: 'chat', 
                sender: data.sender, 
                text: data.text 
            });
        }
    });

    ws.on('close', () => {
        const room = getRoomByClient(ws);
        
        if (room) {
            const leavingUser = ws.userName || 'Неизвестный пользователь';
            
            room.clients = room.clients.filter(client => client !== ws);

            if (room.host === ws) {
                // Хост ушел, закрываем комнату
                broadcast(ws.roomCode, { type: 'chat', sender: 'System', text: `Хост (${leavingUser}) покинул сессию. Комната закрыта.`, isSystem: true });
                delete rooms[ws.roomCode];
                console.log(`[ROOM] Комната ${ws.roomCode} закрыта (ушел хост).`);
            } else {
                 broadcast(ws.roomCode, { type: 'chat', sender: 'System', text: `${leavingUser} покинул сессию.`, isSystem: true });
                 console.log(`[ROOM] ${leavingUser} покинул комнату ${ws.roomCode}.`);
            }
        }
        console.log('🚪 WebSocket соединение закрыто.');
    });
});

// Запуск сервера
server.listen(PORT, () => {
    console.log(`\n=================================================`);
    console.log(`🎄 Сервер SyncStream запущен на http://localhost:${PORT}`);
    console.log(`=================================================\n`);
});