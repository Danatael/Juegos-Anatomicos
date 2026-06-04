const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'memorama-anatomico.html'));
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Almacenar salas en memoria
const rooms = {};

function makeCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

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

io.on('connection', (socket) => {
  console.log(`🟢 socket conectado: ${socket.id}`);

  socket.on('createRoom', ({ name }) => {
    const code = makeCode();
    rooms[code] = {
      hostId: socket.id,
      players: [{
        id: socket.id,
        name,
        avatarIdx: 0,
        colorIdx: 0,
        puntosTotal: 0,
        nivelesJugados: [],
        terminado: false,
      }],
      semester: null,
      levelIdx: 0,
      currentPermutation: null,
      countdownEndsAt: null,
      countdownTimer: null,
    };
    socket.join(code);
    socket.emit('roomCreated', snapshotRoom(code));
    console.log(`✅ Sala creada: ${code} por ${name} (${socket.id})`);
  });

  socket.on('joinRoom', ({ code, name }) => {
    console.log(`🔍 Intentando unir a ${name} a la sala ${code}`);
    const room = rooms[code];
    if (!room) {
      console.log(`❌ Sala ${code} no encontrada`);
      socket.emit('errorMsg', 'Sala no encontrada');
      return;
    }

    const player = {
      id: socket.id,
      name,
      avatarIdx: room.players.length % 12,
      colorIdx: room.players.length % 8,
      puntosTotal: 0,
      nivelesJugados: [],
      terminado: false,
    };
    room.players.push(player);
    socket.join(code);
    const snapshot = emitRoomState(code);
    socket.emit('joinedRoom', snapshot);
    console.log(`✅ ${name} (${socket.id}) se unió a sala ${code}`);
  });

  socket.on('startRoomCountdown', ({ code, semester, levelIdx, pairsCount }) => {
    const room = rooms[code];
    if (!room) {
      socket.emit('errorMsg', 'Sala no encontrada');
      return;
    }
    if (room.hostId !== socket.id) {
      socket.emit('errorMsg', 'Solo el creador puede comenzar');
      return;
    }
    if (room.countdownTimer) {
      socket.emit('errorMsg', 'La partida ya está en cuenta regresiva');
      return;
    }

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

      let permutation = null;
      if (Number.isInteger(pairsCount) && pairsCount > 0) {
        permutation = Array.from({ length: pairsCount * 2 }, (_, i) => i);
        for (let i = permutation.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [permutation[i], permutation[j]] = [permutation[j], permutation[i]];
        }
      }
      activeRoom.currentPermutation = permutation;
      io.to(code).emit('gameStarted', {
        ...snapshotRoom(code),
        permutation,
      });
      activeRoom.countdownTimer = null;
      activeRoom.countdownEndsAt = null;
      console.log(`🎮 Juego iniciado en sala ${code} (nivel ${levelIdx})`);
    }, 5000);
  });

  socket.on('startRoomGame', ({ code, semester, levelIdx, pairsCount }) => {
    const room = rooms[code];
    if (!room) return;
    room.semester = semester;
    room.levelIdx = levelIdx;
    let permutation = null;
    if (pairsCount && Number.isInteger(pairsCount) && pairsCount > 0) {
      permutation = Array.from({ length: pairsCount * 2 }, (_, i) => i);
      for (let i = permutation.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [permutation[i], permutation[j]] = [permutation[j], permutation[i]];
      }
      room.currentPermutation = permutation;
    }
    io.to(code).emit('gameStarted', {
      code,
      players: room.players,
      semester,
      levelIdx,
      permutation,
    });
    console.log(`🎮 startRoomGame: sala ${code}, semestre ${semester}, nivel ${levelIdx}`);
  });

  socket.on('playerResult', ({ code, playerId, result }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (player) {
      player.puntosTotal = (player.puntosTotal || 0) + (result.pts || 0);
      player.nivelesJugados.push(result);
      console.log(`📊 Resultado recibido de ${player.name} en sala ${code}: +${result.pts} pts`);
    }
    io.to(code).emit('updateRanking', snapshotRoom(code));
  });

  socket.on('disconnect', () => {
    console.log(`🔴 socket desconectado: ${socket.id}`);
    for (const code of Object.keys(rooms)) {
      const room = rooms[code];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        const name = room.players[idx].name;
        room.players.splice(idx, 1);
        emitRoomState(code);

        if (room.players.length === 0) {
          if (room.countdownTimer) clearTimeout(room.countdownTimer);
          delete rooms[code];
          console.log(`🗑️ Sala ${code} eliminada (sin jugadores)`);
        } else {
          if (room.hostId === socket.id) {
            room.hostId = room.players[0].id;
            console.log(`👑 Nuevo anfitrión en sala ${code}: ${room.players[0].name}`);
          }
          console.log(`🚪 ${name} salió de la sala ${code}`);
        }
        break;
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