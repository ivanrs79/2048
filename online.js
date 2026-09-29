// Online play over WebRTC using PeerJS. The host's peer id is derived from a
// short room code; the guest connects to it. The host is authoritative for the
// match: it picks the seed and rules and decides the outcome.
//
// Messages (all carry `round` except rematch requests from older rounds):
//   start   host -> guest   { round, seed, rules }
//   state   both            { round, tiles, removed, score, won, over }
//   attack  both            { round, count }
//   result  host -> guest   { round, winner: 'host' | 'guest' | 'draw' }
//   rematch guest -> host   { round }

const PEER_PREFIX = 'web2048-room-';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const CONNECT_TIMEOUT = 15000;

function makeRoomCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

class OnlineSession {
  constructor(handlers) {
    this.handlers = handlers;
    this.peer = null;
    this.conn = null;
    this.code = null;
    this.isHost = false;
    this.connected = false;
    this.closed = false;
  }

  host(onReady) {
    this.isHost = true;
    this.code = makeRoomCode();
    this.peer = new Peer(PEER_PREFIX + this.code);
    this.peer.on('open', () => onReady(this.code));
    this.peer.on('connection', conn => {
      if (this.conn) {
        conn.on('open', () => conn.close()); // room is full
        return;
      }
      this.attach(conn);
    });
    this.peer.on('error', err => {
      if (err.type === 'unavailable-id') {
        this.peer.destroy(); // code collision, try another
        this.host(onReady);
      } else {
        this.emit('onError', err.type);
      }
    });
  }

  join(code) {
    this.code = code;
    this.peer = new Peer();
    this.peer.on('open', () => {
      this.attach(this.peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' }));
    });
    this.peer.on('error', err => this.emit('onError', err.type));
    setTimeout(() => {
      if (!this.connected) this.emit('onError', 'timeout');
    }, CONNECT_TIMEOUT);
  }

  attach(conn) {
    this.conn = conn;
    conn.on('open', () => {
      this.connected = true;
      this.emit('onConnect');
    });
    conn.on('data', msg => this.emit('onMessage', msg));
    conn.on('close', () => this.emit('onDisconnect'));
    conn.on('error', () => this.emit('onDisconnect'));
  }

  send(msg) {
    if (this.connected && !this.closed) this.conn.send(msg);
  }

  emit(name, ...args) {
    if (!this.closed) this.handlers[name](...args);
  }

  close() {
    this.closed = true;
    if (this.peer) this.peer.destroy();
  }
}

// Read-only stand-in for the opponent's Game2048, fed by 'state' messages.
// Has just enough of the Game2048 surface for BoardView, judge() and overlays.
class RemoteBoard {
  constructor(size) {
    this.size = size;
    this.tileList = [];
    this.score = 0;
    this.won = false;
    this.over = false;
    this.keepPlaying = false;
  }

  tiles() {
    return this.tileList;
  }

  apply(state) {
    this.tileList = state.tiles;
    this.score = state.score;
    this.won = state.won;
    this.over = state.over;
  }
}

function snapshot(game, removed) {
  return {
    tiles: game.tiles().map(({ id, value, r, c, stone, turns, isNew, isMerged }) =>
      ({ id, value, r, c, stone, turns, isNew, isMerged })),
    removed: removed.map(({ id, r, c, stone }) => ({ id, r, c, stone })),
    score: game.score,
    won: game.won,
    over: game.over,
  };
}

// ---------- Lobby & online match glue ----------

const lobbyEl = document.getElementById('lobby');
const lobbyStatusEl = document.getElementById('lobby-status');
const createRoomBtn = document.getElementById('create-room');
const joinRoomBtn = document.getElementById('join-room');
const joinCodeInput = document.getElementById('join-code');
const roomInfoEl = document.getElementById('room-info');
const roomCodeEl = document.getElementById('room-code');
const copyCodeBtn = document.getElementById('copy-code');

const ERROR_MESSAGES = {
  'peer-unavailable': 'Room not found. Check the code and try again.',
  timeout: "Couldn't connect to the room. Check the code, or your networks may be blocking direct connections.",
  network: "Couldn't reach the matchmaking server. Check your internet connection.",
  'server-error': "Couldn't reach the matchmaking server. Check your internet connection.",
  'socket-error': "Couldn't reach the matchmaking server. Check your internet connection.",
  'socket-closed': 'Lost connection to the matchmaking server.',
  'browser-incompatible': "This browser doesn't support WebRTC, which online play needs.",
};

let round = 0; // match number; messages from older matches are ignored

function setLobbyStatus(text) {
  lobbyStatusEl.textContent = text;
}

function showLobby(message = '') {
  setLayout({ two: false, intro: MODES.online.intro, lobby: true });
  resetArena();
  roomInfoEl.hidden = true;
  createRoomBtn.disabled = false;
  joinRoomBtn.disabled = false;
  setLobbyStatus(message);
}

function peerAvailable() {
  if (typeof Peer !== 'undefined') return true;
  setLobbyStatus("Couldn't load PeerJS. Check your internet connection and reload the page.");
  return false;
}

function leaveOnline() {
  if (net) net.close();
  net = null;
}

function createRoom() {
  if (!peerAvailable()) return;
  leaveOnline();
  net = new OnlineSession(onlineHandlers);
  net.rules = document.querySelector('input[name="online-rules"]:checked').value;
  createRoomBtn.disabled = true;
  joinRoomBtn.disabled = true;
  setLobbyStatus('Creating room…');
  net.host(code => {
    roomCodeEl.textContent = code;
    roomInfoEl.hidden = false;
    setLobbyStatus('Waiting for your opponent to join…');
  });
}

function joinRoom() {
  const code = joinCodeInput.value.trim().toUpperCase();
  if (code.length !== CODE_LENGTH) {
    setLobbyStatus(`Enter the ${CODE_LENGTH}-character room code.`);
    return;
  }
  if (!peerAvailable()) return;
  leaveOnline();
  net = new OnlineSession(onlineHandlers);
  createRoomBtn.disabled = true;
  joinRoomBtn.disabled = true;
  setLobbyStatus('Connecting…');
  net.join(code);
}

function inviteText(code) {
  if (location.protocol.startsWith('http')) {
    return `${location.origin}${location.pathname}#join=${code}`;
  }
  return code;
}

async function copyRoomCode() {
  try {
    await navigator.clipboard.writeText(inviteText(roomCodeEl.textContent));
    copyCodeBtn.textContent = 'Copied!';
  } catch {
    copyCodeBtn.textContent = 'Copy failed';
  }
  setTimeout(() => (copyCodeBtn.textContent = 'Copy'), 1500);
}

// Host only: begin a new match for both sides.
function startOnlineRound() {
  round++;
  const seed = randomSeed();
  net.send({ type: 'start', round, seed, rules: net.rules });
  beginOnlineMatch(seed, net.rules);
}

function beginOnlineMatch(seed, matchRules) {
  rules = matchRules;
  setLayout({
    two: true,
    intro: `${RULES[rules]} <span class="room-tag">Room ${net.code}</span>`,
  });
  resetArena();
  const me = addPlayer({
    game: new Game2048(4, seed),
    name: 'You',
    keys: SOLO_KEYS,
    hint: '<strong>Arrow keys</strong>, <strong>WASD</strong> or swipe',
  });
  addPlayer({
    game: new RemoteBoard(4),
    name: 'Opponent',
    keys: {},
    hint: 'Live view of your opponent',
    remote: true,
  });
  players.forEach(p => refresh(p));
  sendState(me, []);
}

function sendState(player, removed) {
  net.send({ type: 'state', round, ...snapshot(player.game, removed) });
}

// Called by move() after the local player made a move.
function onlineMoved(player, removed, stones) {
  sendState(player, removed);
  if (stones > 0) net.send({ type: 'attack', round, count: stones });
  if (net.isHost) hostJudge();
}

function hostJudge() {
  if (outcome) return;
  judge();
  if (!outcome) return;
  const winner = outcome.draw ? 'draw' : outcome.winner === 0 ? 'host' : 'guest';
  net.send({ type: 'result', round, winner });
}

function requestRematch() {
  if (!net || !net.connected) return;
  if (net.isHost) startOnlineRound();
  else net.send({ type: 'rematch', round });
}

const onlineHandlers = {
  onConnect() {
    if (net.isHost) startOnlineRound();
    else setLobbyStatus('Connected! Starting…');
  },

  onMessage(msg) {
    const [me, opponent] = players;
    if (msg.type === 'start') {
      round = msg.round;
      beginOnlineMatch(msg.seed, msg.rules);
      return;
    }
    if (msg.type === 'rematch') {
      if (net.isHost && msg.round === round) startOnlineRound();
      return;
    }
    if (msg.round !== round || !opponent) return;

    if (msg.type === 'state') {
      opponent.game.apply(msg);
      if (net.isHost) hostJudge();
      refresh(opponent, msg.removed);
      refresh(me);
    } else if (msg.type === 'attack') {
      if (outcome) return;
      me.game.addStones(msg.count);
      sendState(me, []);
      if (net.isHost) hostJudge();
      refresh(me);
      refresh(opponent);
    } else if (msg.type === 'result') {
      outcome = msg.winner === 'draw' ? { draw: true } : { winner: msg.winner === 'guest' ? 0 : 1 };
      refresh(me);
      refresh(opponent);
    }
  },

  onDisconnect() {
    leaveOnline();
    showLobby('Your opponent left the game.');
  },

  onError(type) {
    leaveOnline();
    showLobby(ERROR_MESSAGES[type] || `Connection error (${type}).`);
  },
};

createRoomBtn.addEventListener('click', createRoom);
joinRoomBtn.addEventListener('click', joinRoom);
joinCodeInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') joinRoom();
});
copyCodeBtn.addEventListener('click', copyRoomCode);
