const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const {
  INITIAL_RACK_SIZE,
  MAX_PLAYERS,
  createShuffledTileSet,
  cloneBoard,
  applyMove,
  validateBoard,
  validateInitialMeld,
  reconcileRackFromBoard,
  sanitizeAndNormalizeBoard,
} = require('./shared/gameEngine');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function createRoom(code) {
  const room = {
    code,
    started: false,
    hostSocketId: null,
    players: [],
    turnIndex: 0,
    pool: [],
    board: [],
    tileLookup: new Map(),
    winnerId: null,
    turnState: null,
  };
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(code);
}

function getCurrentPlayer(room) {
  return room.players[room.turnIndex] || null;
}

function findPlayer(room, socketId) {
  return room.players.find((p) => p.socketId === socketId) || null;
}

function getTile(room, tileId) {
  return room.tileLookup.get(tileId) || null;
}

function createPlayer(socketId, name, seatIndex) {
  return {
    id: `p_${Math.random().toString(36).slice(2, 10)}`,
    socketId,
    name: (name || 'Player').trim().slice(0, 20) || 'Player',
    rack: [],
    seatIndex,
    hasCompletedInitialMeld: false,
  };
}

function serializeBoard(room, board) {
  return board.map((set) => ({
    id: set.id,
    tiles: set.tiles
      .map((tileId) => getTile(room, tileId))
      .filter(Boolean),
  }));
}

function getVisibleBoardForSocket(room, socketId) {
  const me = findPlayer(room, socketId);
  const current = getCurrentPlayer(room);
  const isCurrent = me && current && me.id === current.id;
  return isCurrent && room.turnState ? room.turnState.workingBoard : room.board;
}

function serializeForPlayer(room, socketId) {
  const me = findPlayer(room, socketId);
  const current = getCurrentPlayer(room);
  const visibleBoard = getVisibleBoardForSocket(room, socketId);

  return {
    roomCode: room.code,
    started: room.started,
    winnerId: room.winnerId,
    currentPlayerId: current?.id || null,
    board: serializeBoard(room, visibleBoard),
    committedBoard: serializeBoard(room, room.board),
    poolCount: room.pool.length,
    observerAnimationMode: !!(me && current && me.id !== current.id),
    me: me
      ? {
          id: me.id,
          socketId: me.socketId,
          name: me.name,
          seatIndex: me.seatIndex,
          hasCompletedInitialMeld: !!me.hasCompletedInitialMeld,
          rack: me.rack.map((tileId) => getTile(room, tileId)).filter(Boolean),
        }
      : null,
    players: room.players.map((p) => ({
      id: p.id,
      socketId: p.socketId,
      name: p.name,
      seatIndex: p.seatIndex,
      rackCount: p.rack.length,
      hasCompletedInitialMeld: !!p.hasCompletedInitialMeld,
      isCurrentTurn: current?.id === p.id,
    })),
  };
}

function broadcastState(room) {
  for (const player of room.players) {
    io.to(player.socketId).emit('state', serializeForPlayer(room, player.socketId));
  }
}

function emitObserverMove(room, activePlayerId, move, seq) {
  for (const player of room.players) {
    if (player.id === activePlayerId) continue;
    io.to(player.socketId).emit('turn_move_observed', {
      playerId: activePlayerId,
      move,
      seq,
    });
  }
}

function startTurn(room) {
  const current = getCurrentPlayer(room);
  if (!current) {
    room.turnState = null;
    return;
  }

  room.turnState = {
    activePlayerId: current.id,
    boardAtTurnStart: cloneBoard(room.board),
    rackAtTurnStart: [...current.rack],
    workingBoard: cloneBoard(room.board),
    moveLog: [],
    seq: 0,
  };
}

function startGame(room) {
  const fullSet = createShuffledTileSet();
  room.tileLookup = new Map(fullSet.map((tile) => [tile.id, tile]));
  room.pool = fullSet.map((tile) => tile.id);
  room.board = [];
  room.winnerId = null;
  room.turnIndex = 0;
  room.started = true;

  room.players.forEach((player, idx) => {
    player.seatIndex = idx;
    player.rack = [];
    player.hasCompletedInitialMeld = false;
  });

  for (let i = 0; i < INITIAL_RACK_SIZE; i++) {
    for (const player of room.players) {
      const tileId = room.pool.shift();
      if (tileId) player.rack.push(tileId);
    }
  }

  startTurn(room);
}

function ensureTurnOwner(room, socketId) {
  const player = findPlayer(room, socketId);
  const current = getCurrentPlayer(room);

  if (!player || !current || player.id !== current.id) {
    throw new Error('Not your turn');
  }

  return player;
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ name }, cb) => {
    try {
      const room = createRoom(generateRoomCode());
      room.hostSocketId = socket.id;

      const player = createPlayer(socket.id, name, 0);
      room.players.push(player);

      socket.join(room.code);
      broadcastState(room);

      cb?.({
        ok: true,
        roomCode: room.code,
        playerId: player.id,
      });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on('join_room', ({ roomCode, name }, cb) => {
    try {
      const normalizedCode = (roomCode || '').trim().toUpperCase();
      const room = getRoom(normalizedCode);

      if (!room) throw new Error('Room not found');
      if (room.started) throw new Error('Game already started');
      if (room.players.length >= MAX_PLAYERS) throw new Error('Room full');

      const player = createPlayer(socket.id, name, room.players.length);
      room.players.push(player);

      socket.join(room.code);
      broadcastState(room);

      io.to(room.code).emit('webrtc:user_joined', { socketId: socket.id });

      cb?.({
        ok: true,
        roomCode: room.code,
        playerId: player.id,
      });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on('start_game', ({ roomCode }, cb) => {
    try {
      const room = getRoom(roomCode);
      if (!room) throw new Error('Room not found');
      if (room.hostSocketId !== socket.id) throw new Error('Only host can start');
      if (room.players.length < 2) throw new Error('Need at least 2 players');

      startGame(room);
      broadcastState(room);

      cb?.({ ok: true });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on('turn_move', ({ roomCode, move }, cb) => {
    try {
      const room = getRoom(roomCode);
      if (!room) throw new Error('Room not found');

      const player = ensureTurnOwner(room, socket.id);
      if (!room.turnState || room.turnState.activePlayerId !== player.id) {
        throw new Error('Turn state missing');
      }

      const result = applyMove({
        board: room.turnState.workingBoard,
        playerRack: player.rack,
        move,
      });

      room.turnState.workingBoard = sanitizeAndNormalizeBoard(result.board);
      player.rack = result.rack;

      const seq = ++room.turnState.seq;
      room.turnState.moveLog.push({
        seq,
        move,
        ts: Date.now(),
      });

      io.to(player.socketId).emit('state', serializeForPlayer(room, player.socketId));
      emitObserverMove(room, player.id, move, seq);

      for (const other of room.players) {
        if (other.id !== player.id) {
          io.to(other.socketId).emit('state', serializeForPlayer(room, other.socketId));
        }
      }

      cb?.({ ok: true });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on('reset_turn', ({ roomCode }, cb) => {
    try {
      const room = getRoom(roomCode);
      if (!room) throw new Error('Room not found');

      const player = ensureTurnOwner(room, socket.id);
      if (!room.turnState) throw new Error('Turn state missing');

      player.rack = [...room.turnState.rackAtTurnStart];
      room.turnState.workingBoard = cloneBoard(room.turnState.boardAtTurnStart);
      room.turnState.moveLog = [];
      room.turnState.seq = 0;

      broadcastState(room);
      io.to(room.code).emit('turn_reset', { playerId: player.id });

      cb?.({ ok: true });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on('submit_turn', ({ roomCode }, cb) => {
    try {
      const room = getRoom(roomCode);
      if (!room) throw new Error('Room not found');

      const player = ensureTurnOwner(room, socket.id);
      if (!room.turnState) throw new Error('Turn state missing');

      const boardCheck = validateBoard(room.turnState.workingBoard, room.tileLookup);
      if (!boardCheck.ok) throw new Error(boardCheck.error);

      if (!player.hasCompletedInitialMeld) {
        const initialCheck = validateInitialMeld({
          beforeBoard: room.turnState.boardAtTurnStart,
          afterBoard: room.turnState.workingBoard,
          rackAtTurnStart: room.turnState.rackAtTurnStart,
          tileLookup: room.tileLookup,
        });

        if (!initialCheck.ok) throw new Error(initialCheck.error);
      }

      player.rack = reconcileRackFromBoard({
        boardAtTurnStart: room.turnState.boardAtTurnStart,
        submittedBoard: room.turnState.workingBoard,
        rackAtTurnStart: room.turnState.rackAtTurnStart,
      });

      room.board = cloneBoard(room.turnState.workingBoard);
      const moveLog = [...room.turnState.moveLog];

      if (!player.hasCompletedInitialMeld) {
        player.hasCompletedInitialMeld = true;
      }

      if (player.rack.length === 0) {
        room.winnerId = player.id;
      }

      io.to(room.code).emit('turn_committed', {
        playerId: player.id,
        moveLog,
      });

      room.turnIndex = (room.turnIndex + 1) % room.players.length;
      startTurn(room);
      broadcastState(room);

      cb?.({ ok: true });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on('draw_and_pass', ({ roomCode }, cb) => {
    try {
      const room = getRoom(roomCode);
      if (!room) throw new Error('Room not found');

      const player = ensureTurnOwner(room, socket.id);

      if (room.pool.length > 0) {
        const tileId = room.pool.shift();
        player.rack.push(tileId);
      }

      io.to(room.code).emit('turn_reset', { playerId: player.id });

      room.turnIndex = (room.turnIndex + 1) % room.players.length;
      startTurn(room);
      broadcastState(room);

      cb?.({ ok: true });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on('webrtc:offer', ({ to, offer, from }) => {
    io.to(to).emit('webrtc:offer', { from, offer });
  });

  socket.on('webrtc:answer', ({ to, answer, from }) => {
    io.to(to).emit('webrtc:answer', { from, answer });
  });

  socket.on('webrtc:ice', ({ to, candidate, from }) => {
    io.to(to).emit('webrtc:ice', { from, candidate });
  });

  socket.on('disconnect', () => {
    for (const [code, room] of rooms.entries()) {
      const idx = room.players.findIndex((p) => p.socketId === socket.id);
      if (idx === -1) continue;

      const leaving = room.players[idx];
      room.players.splice(idx, 1);

      room.players.forEach((p, i) => {
        p.seatIndex = i;
      });

      if (room.turnIndex >= room.players.length) {
        room.turnIndex = 0;
      }

      if (room.hostSocketId === socket.id) {
        room.hostSocketId = room.players[0]?.socketId || null;
      }

      io.to(code).emit('player_left', {
        playerId: leaving.id,
        socketId: socket.id,
      });

      if (room.players.length === 0) {
        rooms.delete(code);
      } else {
        if (room.started) {
          startTurn(room);
        }
        broadcastState(room);
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rummikub V2 running on http://0.0.0.0:${PORT}`);
});