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
const rooms = {}; // { code: { hostId, players: [{id,name,avatarIdx,colorIdx,puntosTotal,nivelesJugados,terminado}], semester, levelIdx, currentPermutation }}

function makeCode() { return Math.random().toString(36).slice(2,8).toUpperCase(); }

io.on('connection', socket => {
  console.log('socket connected', socket.id);

  socket.on('createRoom', ({ name }) => {
    const code = makeCode();
    rooms[code] = { hostId: socket.id, players: [{ id: socket.id, name, avatarIdx: 0, colorIdx: 0, puntosTotal: 0, nivelesJugados: [], terminado: false }] };
    socket.join(code);
    socket.emit('roomCreated', { code, players: rooms[code].players });
    console.log(`Room ${code} created by ${name}`);
  });

  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms[code];
    if (!room) { socket.emit('errorMsg', 'Sala no encontrada'); return; }
    const player = { id: socket.id, name, avatarIdx: room.players.length % 12, colorIdx: room.players.length % 8, puntosTotal: 0, nivelesJugados: [], terminado: false };
    room.players.push(player);
    socket.join(code);
    io.to(code).emit('playerList', { players: room.players });
    socket.emit('joinedRoom', { code, players: room.players });
    console.log(`${name} joined room ${code}`);
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
    io.to(code).emit('updateRanking', { players: room.players });
  });

  socket.on('disconnect', () => {
    console.log('socket disconnect', socket.id);
    for (const code of Object.keys(rooms)) {
      const r = rooms[code];
      const idx = r.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        const name = r.players[idx].name;
        r.players.splice(idx, 1);
        io.to(code).emit('playerList', { players: r.players });
        if (r.players.length === 0) { delete rooms[code]; console.log(`Room ${code} removed`); }
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