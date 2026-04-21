const socket = io();

const state = {
  roomCode: null,
  game: null,
  localStream: null,
  peerConnections: new Map(),
  remoteStreams: new Map(),
  selectedRackTileId: null,
  selectedBoardTile: null,
};

const animationState = {
  queue: [],
  isPlaying: false,
  boardShadow: null,
};

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const els = {
  nameInput: document.getElementById('nameInput'),
  roomCodeInput: document.getElementById('roomCodeInput'),
  roomCodeLabel: document.getElementById('roomCodeLabel'),
  statusLabel: document.getElementById('statusLabel'),
  turnLabel: document.getElementById('turnLabel'),
  poolLabel: document.getElementById('poolLabel'),
  playersList: document.getElementById('playersList'),
  boardSets: document.getElementById('boardSets'),
  rackTiles: document.getElementById('rackTiles'),
  statusBanner: document.getElementById('statusBanner'),
  winnerBanner: document.getElementById('winnerBanner'),
  observerNotice: document.getElementById('observerNotice'),
  localVideo: document.getElementById('localVideo'),
  createRoomBtn: document.getElementById('createRoomBtn'),
  joinRoomBtn: document.getElementById('joinRoomBtn'),
  startGameBtn: document.getElementById('startGameBtn'),
  createSetBtn: document.getElementById('createSetBtn'),
  resetTurnBtn: document.getElementById('resetTurnBtn'),
  submitTurnBtn: document.getElementById('submitTurnBtn'),
  drawPassBtn: document.getElementById('drawPassBtn'),
  lobbyScreen: document.getElementById('lobbyScreen'),
  gameScreen: document.getElementById('gameScreen'),
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getName() {
  return (els.nameInput.value || 'Player').trim().slice(0, 20) || 'Player';
}

function isMyTurn() {
  return !!(state.game?.me && state.game?.currentPlayerId === state.game.me.id);
}

function getCurrentPlayer() {
  return state.game?.players?.find((p) => p.isCurrentTurn) || null;
}

function rackSortValue(tile) {
  const order = { red: 1, blue: 2, black: 3, orange: 4 };
  if (tile.joker) return 999;
  return (order[tile.color] || 99) * 100 + (tile.number || 0);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getRelativeSeat(mySeatIndex, otherSeatIndex, totalPlayers) {
  const delta = (otherSeatIndex - mySeatIndex + totalPlayers) % totalPlayers;
  if (delta === 0) return 'bottom';
  if (delta === 1) return totalPlayers === 2 ? 'top' : 'right';
  if (delta === 2) return 'top';
  if (delta === 3) return 'left';
  return 'off';
}

function getSeatMap() {
  const me = state.game?.me;
  const players = state.game?.players || [];
  const map = {};
  if (!me) return map;

  for (const p of players) {
    map[p.socketId] = getRelativeSeat(me.seatIndex, p.seatIndex, players.length);
  }
  return map;
}

async function initMedia() {
  if (state.localStream) return state.localStream;

  const tryConstraints = [
    {
      video: {
        facingMode: { ideal: 'user' },
        width: { ideal: 640 },
        height: { ideal: 480 },
        aspectRatio: { ideal: 4 / 3 },
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    },
    {
      video: true,
      audio: true,
    },
    {
      video: true,
      audio: false,
    },
  ];

  let lastError = null;

  for (const constraints of tryConstraints) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      state.localStream = stream;
      if (els.localVideo) {
        els.localVideo.srcObject = stream;
      }
      return stream;
    } catch (err) {
      lastError = err;
      console.warn('getUserMedia failed with constraints:', constraints, err);
    }
  }

  console.error('Media init failed:', lastError);

  const reason =
    lastError?.name === 'NotAllowedError'
      ? 'Camera/mic permission was denied, or the page is not running in a secure context.'
      : lastError?.name === 'NotFoundError'
        ? 'No matching camera or microphone was found.'
        : lastError?.name === 'OverconstrainedError'
          ? 'Requested camera settings were too strict for this device.'
          : 'Camera/mic access failed.';

  alert(reason);
  return null;
}

async function ensureConnectionFor(otherSocketId, createOffer) {
  if (state.peerConnections.has(otherSocketId)) {
    return state.peerConnections.get(otherSocketId);
  }

  const pc = new RTCPeerConnection(rtcConfig);
  state.peerConnections.set(otherSocketId, pc);

  const stream = await initMedia();
  if (stream) {
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc:ice', {
        to: otherSocketId,
        from: socket.id,
        candidate: event.candidate,
      });
    }
  };

  pc.ontrack = (event) => {
    state.remoteStreams.set(otherSocketId, event.streams[0]);
    renderSeats();
  };

  if (createOffer) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc:offer', {
      to: otherSocketId,
      from: socket.id,
      offer,
    });
  }

  return pc;
}

async function ensurePeerConnections() {
  const players = state.game?.players || [];
  for (const player of players) {
    if (player.socketId === socket.id) continue;
    if (!state.peerConnections.has(player.socketId)) {
      await ensureConnectionFor(player.socketId, true);
    }
  }
}

function handleAck(res) {
  if (!res?.ok) {
    alert(res?.error || 'Action failed');
  }
}

function emitRoomEvent(eventName) {
  if (!state.roomCode) return;
  socket.emit(eventName, { roomCode: state.roomCode }, handleAck);
}

function updateScreenVisibility() {
  const inRoom = !!state.roomCode;
  els.lobbyScreen.classList.toggle('hidden', inRoom);
  els.gameScreen.classList.toggle('hidden', !inRoom);
}

els.createRoomBtn.addEventListener('click', async () => {
  await initMedia();
  socket.emit('create_room', { name: getName() }, (res) => {
    if (!res?.ok) return handleAck(res);
    state.roomCode = res.roomCode;
    updateScreenVisibility();
    updateMeta();
  });
});

els.joinRoomBtn.addEventListener('click', async () => {
  await initMedia();
  const roomCode = (els.roomCodeInput.value || '').trim().toUpperCase();
  socket.emit('join_room', { roomCode, name: getName() }, (res) => {
    if (!res?.ok) return handleAck(res);
    state.roomCode = res.roomCode;
    updateScreenVisibility();
    updateMeta();
  });
});

els.startGameBtn.addEventListener('click', () => emitRoomEvent('start_game'));
els.resetTurnBtn.addEventListener('click', () => emitRoomEvent('reset_turn'));
els.submitTurnBtn.addEventListener('click', () => emitRoomEvent('submit_turn'));
els.drawPassBtn.addEventListener('click', () => emitRoomEvent('draw_and_pass'));

els.createSetBtn.addEventListener('click', () => {
  if (!state.roomCode || !isMyTurn()) return;

  const setId = `set_${Math.random().toString(36).slice(2, 10)}`;
  socket.emit(
    'turn_move',
    {
      roomCode: state.roomCode,
      move: { type: 'create_set', setId },
    },
    handleAck
  );
});

socket.on('state', async (game) => {
  state.game = game;
  updateMeta();
  render();
  await ensurePeerConnections();
  updateScreenVisibility();
});

socket.on('webrtc:user_joined', async ({ socketId }) => {
  if (socketId === socket.id) return;
  await ensureConnectionFor(socketId, true);
});

socket.on('webrtc:offer', async ({ from, offer }) => {
  const pc = await ensureConnectionFor(from, false);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('webrtc:answer', { to: from, from: socket.id, answer });
});

socket.on('webrtc:answer', async ({ from, answer }) => {
  const pc = state.peerConnections.get(from);
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('webrtc:ice', async ({ from, candidate }) => {
  const pc = state.peerConnections.get(from);
  if (!pc) return;
  try {
    await pc.addIceCandidate(candidate);
  } catch (err) {
    console.warn('ICE add failed', err);
  }
});

socket.on('player_left', ({ socketId }) => {
  const pc = state.peerConnections.get(socketId);
  if (pc) pc.close();
  state.peerConnections.delete(socketId);
  state.remoteStreams.delete(socketId);
  renderSeats();
});

socket.on('turn_move_observed', (evt) => {
  animationState.queue.push(evt);
  if (!animationState.isPlaying) {
    playNextMoveAnimation();
  }
});

socket.on('turn_reset', () => {
  animationState.queue = [];
  animationState.isPlaying = false;
  animationState.boardShadow = null;
  render();
});

socket.on('turn_committed', () => {
  animationState.queue = [];
  animationState.isPlaying = false;
  animationState.boardShadow = null;
  render();
});

function findTileInKnownState(tileId) {
  for (const set of state.game?.board || []) {
    for (const tile of set.tiles) {
      if (tile.id === tileId) return tile;
    }
  }
  for (const set of state.game?.committedBoard || []) {
    for (const tile of set.tiles) {
      if (tile.id === tileId) return tile;
    }
  }
  for (const tile of state.game?.me?.rack || []) {
    if (tile.id === tileId) return tile;
  }
  return null;
}

function getSetEl(setId) {
  return document.querySelector(`[data-set-id="${setId}"]`);
}

function getBoardAnchor() {
  return document.querySelector('.board-area');
}

function getSeatAnchorForPlayer(playerId) {
  const player = state.game?.players?.find((p) => p.id === playerId);
  if (!player || !state.game?.me) return document.getElementById('seatTop');

  const relative = getRelativeSeat(
    state.game.me.seatIndex,
    player.seatIndex,
    state.game.players.length
  );

  if (relative === 'left') return document.getElementById('seatLeft');
  if (relative === 'right') return document.getElementById('seatRight');
  if (relative === 'top') return document.getElementById('seatTop');
  return document.getElementById('seatTop');
}

async function animateGhostBetweenRects(tile, fromRect, toRect) {
  const ghost = makeTileEl(tile, false, false);
  ghost.classList.add('ghost');

  ghost.style.position = 'fixed';
  ghost.style.left = `${fromRect.left}px`;
  ghost.style.top = `${fromRect.top}px`;
  ghost.style.width = `${fromRect.width}px`;
  ghost.style.height = `${fromRect.height}px`;

  document.body.appendChild(ghost);
  await new Promise(requestAnimationFrame);

  const dx = toRect.left - fromRect.left;
  const dy = toRect.top - fromRect.top;
  ghost.style.transition = 'transform 320ms ease';
  ghost.style.transform = `translate(${dx}px, ${dy}px)`;

  await sleep(340);
  ghost.remove();
}

function applyMoveToBoardShadow(move) {
  let board = structuredClone(animationState.boardShadow || []);

  switch (move.type) {
    case 'create_set':
      board.push({ id: move.setId, tiles: [] });
      break;

    case 'rack_to_set': {
      const set = board.find((s) => s.id === move.toSetId);
      const tile = findTileInKnownState(move.tileId);
      if (set && tile) {
        const idx = typeof move.toIndex === 'number' ? move.toIndex : set.tiles.length;
        set.tiles.splice(idx, 0, tile);
      }
      break;
    }

    case 'set_to_set': {
      const from = board.find((s) => s.id === move.fromSetId);
      const to = board.find((s) => s.id === move.toSetId);
      if (from && to) {
        const idx = from.tiles.findIndex((t) => t.id === move.tileId);
        if (idx !== -1) {
          const [tile] = from.tiles.splice(idx, 1);
          const toIdx = typeof move.toIndex === 'number' ? move.toIndex : to.tiles.length;
          to.tiles.splice(toIdx, 0, tile);
        }
      }
      break;
    }

    case 'set_to_rack': {
      const from = board.find((s) => s.id === move.fromSetId);
      if (from) {
        const idx = from.tiles.findIndex((t) => t.id === move.tileId);
        if (idx !== -1) from.tiles.splice(idx, 1);
      }
      break;
    }
  }

  board = board.filter((set) => set.tiles.length > 0 || set.id === move.setId || set.id === move.toSetId);
  animationState.boardShadow = board;
}

async function animateObservedMove(move, playerId) {
  const tile = findTileInKnownState(move.tileId);

  if (move.type === 'rack_to_set' && tile) {
    const fromEl = getSeatAnchorForPlayer(playerId);
    const toEl = getSetEl(move.toSetId) || getBoardAnchor();
    if (fromEl && toEl) {
      await animateGhostBetweenRects(tile, fromEl.getBoundingClientRect(), toEl.getBoundingClientRect());
    }
  } else if (move.type === 'set_to_set' && tile) {
    const fromEl = getSetEl(move.fromSetId) || getBoardAnchor();
    const toEl = getSetEl(move.toSetId) || getBoardAnchor();
    if (fromEl && toEl) {
      await animateGhostBetweenRects(tile, fromEl.getBoundingClientRect(), toEl.getBoundingClientRect());
    }
  } else if (move.type === 'set_to_rack' && tile) {
    const fromEl = getSetEl(move.fromSetId) || getBoardAnchor();
    const toEl = getSeatAnchorForPlayer(playerId);
    if (fromEl && toEl) {
      await animateGhostBetweenRects(tile, fromEl.getBoundingClientRect(), toEl.getBoundingClientRect());
    }
  } else {
    await sleep(180);
  }

  applyMoveToBoardShadow(move);
  render();
  await sleep(80);
}

async function playNextMoveAnimation() {
  if (animationState.queue.length === 0) {
    animationState.isPlaying = false;
    return;
  }

  animationState.isPlaying = true;
  const evt = animationState.queue.shift();

  if (!animationState.boardShadow) {
    animationState.boardShadow = structuredClone(state.game?.committedBoard || state.game?.board || []);
  }

  await animateObservedMove(evt.move, evt.playerId);
  animationState.isPlaying = false;
  playNextMoveAnimation();
}

function updateMeta() {
  els.roomCodeLabel.textContent = state.roomCode || '—';
  els.statusLabel.textContent = state.game?.started ? 'In game' : 'Lobby';
  els.poolLabel.textContent = state.game?.poolCount ?? '—';
  els.turnLabel.textContent = getCurrentPlayer()?.name || '—';
}

function makeTileEl(tile, selected = false, clickable = false) {
  const div = document.createElement('div');
  div.className = `tile ${tile.joker ? 'joker' : tile.color} ${selected ? 'selected' : ''} ${clickable ? 'clickable' : ''}`;
  div.innerHTML = tile.joker
    ? `<div>J</div><div class="small">joker</div>`
    : `<div>${tile.number}</div><div class="small">${tile.color}</div>`;
  return div;
}

function getRenderableBoard() {
  if (state.game?.observerAnimationMode && animationState.boardShadow) {
    return animationState.boardShadow;
  }
  return state.game?.board || [];
}

function handleSetClick(setId) {
  if (!state.roomCode || !isMyTurn()) return;

  if (state.selectedRackTileId) {
    socket.emit(
      'turn_move',
      {
        roomCode: state.roomCode,
        move: {
          type: 'rack_to_set',
          tileId: state.selectedRackTileId,
          toSetId: setId,
        },
      },
      handleAck
    );
    state.selectedRackTileId = null;
    return;
  }

  if (state.selectedBoardTile && state.selectedBoardTile.setId !== setId) {
    socket.emit(
      'turn_move',
      {
        roomCode: state.roomCode,
        move: {
          type: 'set_to_set',
          tileId: state.selectedBoardTile.tileId,
          fromSetId: state.selectedBoardTile.setId,
          toSetId: setId,
        },
      },
      handleAck
    );
    state.selectedBoardTile = null;
  }
}

function renderPlayers() {
  els.playersList.innerHTML = '';

  for (const player of state.game?.players || []) {
    const row = document.createElement('div');
    row.className = `player-row ${player.isCurrentTurn ? 'active' : ''}`;
    row.innerHTML = `
      <div><strong>${escapeHtml(player.name)}</strong></div>
      <div>Rack: ${player.rackCount}</div>
      <div>Initial meld: ${player.hasCompletedInitialMeld ? 'done' : 'pending'}</div>
    `;
    els.playersList.appendChild(row);
  }
}

function renderBoard() {
  els.boardSets.innerHTML = '';
  const board = getRenderableBoard();

  for (const set of board) {
    const setEl = document.createElement('div');
    setEl.className = 'board-set';
    setEl.dataset.setId = set.id;

    if (isMyTurn()) {
      setEl.addEventListener('click', () => handleSetClick(set.id));
    }

    for (const tile of set.tiles) {
      const tileEl = makeTileEl(
        tile,
        state.selectedBoardTile?.tileId === tile.id,
        isMyTurn()
      );
      tileEl.dataset.tileId = tile.id;

      if (isMyTurn()) {
        tileEl.addEventListener('click', (e) => {
          e.stopPropagation();
          state.selectedBoardTile = { tileId: tile.id, setId: set.id };
          state.selectedRackTileId = null;
          render();
        });
      }

      setEl.appendChild(tileEl);
    }

    els.boardSets.appendChild(setEl);
  }
}

function renderRack() {
  els.rackTiles.innerHTML = '';

  const rack = [...(state.game?.me?.rack || [])].sort(
    (a, b) => rackSortValue(a) - rackSortValue(b)
  );

  for (const tile of rack) {
    const tileEl = makeTileEl(
      tile,
      state.selectedRackTileId === tile.id,
      isMyTurn()
    );

    if (isMyTurn()) {
      tileEl.addEventListener('click', () => {
        state.selectedRackTileId =
          state.selectedRackTileId === tile.id ? null : tile.id;
        state.selectedBoardTile = null;
        render();
      });
    }

    els.rackTiles.appendChild(tileEl);
  }
}

function renderMessages() {
  const current = getCurrentPlayer();

  els.statusBanner.textContent = isMyTurn()
    ? 'Your turn. Build or rearrange sets, then submit.'
    : current
      ? `${current.name} is playing.`
      : '';

  els.observerNotice.textContent = state.game?.observerAnimationMode
    ? `${current?.name || 'Player'} is rearranging the table...`
    : '';

  if (state.game?.winnerId) {
    const winner = state.game.players.find((p) => p.id === state.game.winnerId);
    els.winnerBanner.textContent = winner ? `${winner.name} wins` : 'Game finished';
  } else {
    els.winnerBanner.textContent = '';
  }
}

function renderSeats() {
  const seatMap = getSeatMap();

  const slots = {
    top: document.querySelector('[data-seat="top"]'),
    left: document.querySelector('[data-seat="left"]'),
    right: document.querySelector('[data-seat="right"]'),
  };

  for (const seatName of ['top', 'left', 'right']) {
    const video = slots[seatName];
    const wrapper = video.closest('.seat');
    wrapper.querySelector('.seat-label').textContent = '';
    video.srcObject = null;
  }

  for (const player of state.game?.players || []) {
    if (player.socketId === socket.id) continue;

    const relativeSeat = seatMap[player.socketId];
    const video = slots[relativeSeat];
    if (!video) continue;

    const wrapper = video.closest('.seat');
    wrapper.querySelector('.seat-label').textContent = '';

    const stream = state.remoteStreams.get(player.socketId);
    if (stream) {
      video.srcObject = stream;
    }
  }
}

function render() {
  if (!state.game) return;
  renderPlayers();
  renderBoard();
  renderRack();
  renderSeats();
  renderMessages();

  const selected = document.querySelector('.rack-tiles .tile.selected');
  if (selected) {
    selected.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }
}