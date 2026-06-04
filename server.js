const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');

const app = express();
const path = require('path');

// Servir archivos estáticos del directorio del proyecto (p. ej. memorama-anatomico.html)
app.use(express.static(path.join(__dirname)));

// Ruta raíz que devuelve el HTML principal si se solicita '/'
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'memorama-anatomico.html'));
});

// Evitar 404 para favicon requests respondiendo vacío
app.get('/favicon.ico', (req, res) => res.status(204).end());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Almacenar salas en memoria
const rooms = {}; // { code: { hostId, players: [{id,name,avatarIdx,colorIdx,puntosTotal,nivelesJugados,terminado}], semester, levelIdx, currentPermutation, countdownEndsAt, countdownTimer } }

function makeCode() { return Math.random().toString(36).slice(2,8).toUpperCase(); }

function snapshotRoom(code) {
  const room = rooms[code];
  if (!room) return null;
  return {
    code,
    hostId: room.hostId,
    players: room.players,
    semester: room.semester,
    levelIdx: room.levelIdx,
    countdownEndsAt: room.countdownEndsAt || null,
  };
}

function emitRoomState(code) {
  const snapshot = snapshotRoom(code);
  if (!snapshot) return;
  io.to(code).emit('playerList', snapshot);
  return snapshot;
}

io.on('connection', socket => {
  console.log('socket connected', socket.id);

  socket.on('createRoom', ({ name }) => {
    const code = makeCode();
    rooms[code] = { hostId: socket.id, players: [{ id: socket.id, name, avatarIdx: 0, colorIdx: 0, puntosTotal: 0, nivelesJugados: [], terminado: false }], semester: null, levelIdx: 0, currentPermutation: null, countdownEndsAt: null, countdownTimer: null };
    socket.join(code);
    socket.emit('roomCreated', snapshotRoom(code));
    console.log(`Room ${code} created by ${name}`);
  });

  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms[code];
    if (!room) { socket.emit('errorMsg', 'Sala no encontrada'); return; }
    const player = { id: socket.id, name, avatarIdx: room.players.length % 12, colorIdx: room.players.length % 8, puntosTotal: 0, nivelesJugados: [], terminado: false };
    room.players.push(player);
    socket.join(code);
    const snapshot = emitRoomState(code);
    socket.emit('joinedRoom', snapshot);
    console.log(`${name} joined room ${code}`);
  });

  socket.on('startRoomCountdown', ({ code, semester, levelIdx, pairsCount }) => {
    const room = rooms[code];
    if (!room) { socket.emit('errorMsg', 'Sala no encontrada'); return; }
    if (room.hostId !== socket.id) { socket.emit('errorMsg', 'Solo el creador puede comenzar'); return; }
    if (room.countdownTimer) { socket.emit('errorMsg', 'La partida ya está en cuenta regresiva'); return; }

    room.semester = semester || room.semester || 1;
    room.levelIdx = Number.isInteger(levelIdx) ? levelIdx : 0;
    room.countdownEndsAt = Date.now() + 5000;

    io.to(code).emit('countdownStarted', {
      ...snapshotRoom(code),
      seconds: 5,
      countdownEndsAt: room.countdownEndsAt,
    });

    room.countdownTimer = setTimeout(() => {
      const activeRoom = rooms[code];
      if (!activeRoom) return;
      const permutation = Number.isInteger(pairsCount) && pairsCount > 0
        ? (() => {
            const list = Array.from({ length: pairsCount * 2 }, (_, i) => i);
            for (let i = list.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [list[i], list[j]] = [list[j], list[i]];
            }
            return list;
          })()
        : null;
      activeRoom.currentPermutation = permutation;
      io.to(code).emit('gameStarted', { ...snapshotRoom(code), permutation });
      activeRoom.countdownTimer = null;
      activeRoom.countdownEndsAt = null;
    }, 5000);
  });

  socket.on('startRoomGame', ({ code, semester, levelIdx, pairsCount }) => {
    const room = rooms[code];
    if (!room) return;
    room.semester = semester;
    room.levelIdx = levelIdx;
    let permutation = null;
    if (pairsCount && Number.isInteger(pairsCount) && pairsCount>0){
      // generar permutación para 2*pairsCount cartas
      permutation = Array.from({length:pairsCount*2},(_,i)=>i);
      for(let i=permutation.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [permutation[i],permutation[j]]=[permutation[j],permutation[i]]; }
      room.currentPermutation = permutation;
    }
    io.to(code).emit('gameStarted', { code, players: room.players, semester, levelIdx, permutation });
    console.log(`Game started in ${code} sem:${semester} lvl:${levelIdx} permLen:${permutation?permutation.length:0}`);
  });

  socket.on('playerResult', ({ code, playerId, result }) => {
    const room = rooms[code];
    if (!room) return;
    const p = room.players.find(pp => pp.id === playerId);
    if (p) { p.puntosTotal = (p.puntosTotal || 0) + (result.pts || 0); p.nivelesJugados.push(result); }
    io.to(code).emit('updateRanking', snapshotRoom(code));
  });

  socket.on('disconnect', () => {
    console.log('socket disconnect', socket.id);
    for (const code of Object.keys(rooms)) {
      const r = rooms[code];
      const idx = r.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        const name = r.players[idx].name;
        r.players.splice(idx, 1);
        emitRoomState(code);
        if (r.players.length === 0) {
          if (r.countdownTimer) clearTimeout(r.countdownTimer);
          delete rooms[code];
          console.log(`Room ${code} removed`);
        }
        else { if (r.hostId === socket.id) r.hostId = r.players[0].id; }
        console.log(`${name} left room ${code}`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();

  console.log('\n🚀 Servidor iniciado');
  console.log(`🌐 Local:   http://localhost:${PORT}`);

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`📱 Red:     http://${net.address}:${PORT}`);
      }
    }
  }

  console.log('\nEsperando conexiones...\n');
});