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
//   hello   both            { round, name }   player name, sent at the start of each match
//   ping    both            {}                heartbeat every HEARTBEAT_INTERVAL while connected
//   bye     both            { reason? }       "I'm leaving" (page closed/reloaded, or left the match);
//                                             reason 'away' = "you were away too long, match over"
//   away    both            { round }         I switched to another app / tab
//   back    both            { round }         I'm back

const PEER_PREFIX = 'web2048-room-';
// Invite links point here when the page itself isn't reachable by others
// (opened from disk or localhost).
const PUBLIC_URL = 'https://ivanrs79.github.io/2048/';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const CONNECT_TIMEOUT = 15000;
// WebRTC often doesn't report a closed or reloaded tab (or only much later),
// so both sides send a heartbeat and give up after HEARTBEAT_TIMEOUT of silence.
const HEARTBEAT_INTERVAL = 2000;
const HEARTBEAT_TIMEOUT = 10000;
// A browser in the background often keeps running (and sending heartbeats),
// so switching away is announced explicitly and allowed for this long.
const AWAY_TIMEOUT = 10000;
const MATCH_SLOTS = 3; // waiting spots per rule set for random matchmaking
const PROBE_TIMEOUT = 6000; // give up on a waiting spot that doesn't answer
const WAITER_PROBE_INTERVAL = 5000;
const LONELY_AFTER = 20000; // offer the bot if nobody shows up
const LONELY_REPEAT = 45000; // ask again after "Keep waiting"
const NAME_KEY = 'game2048-name';
const NAME_MAX = 16;

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
    this.extraPeers = []; // matchmaking may open more than one Peer
    this.probeTimer = null;
    this.probing = false;
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

  attach(conn, { alreadyOpen = false } = {}) {
    this.conn = conn;
    if (!alreadyOpen) {
      conn.on('open', () => {
        this.connected = true;
        this.startHeartbeat();
        this.emit('onConnect');
      });
    }
    conn.on('data', msg => {
      this.lastSeen = Date.now();
      if (msg && msg.type === 'ping') {
        this.peerSendsPings = true;
        return;
      }
      if (msg && msg.type === 'bye') return this.lost(msg.reason === 'away' ? 'you-away' : 'left');
      this.emit('onMessage', msg);
    });
    conn.on('close', () => this.lost('left'));
    conn.on('error', () => this.lost('left'));
  }

  startHeartbeat() {
    this.lastSeen = Date.now();
    // Only time out opponents that send pings themselves, so an opponent on
    // an older version of the game isn't dropped after 10 seconds.
    this.peerSendsPings = false;
    this.heartbeat = setInterval(() => {
      this.send({ type: 'ping' });
      if (this.peerSendsPings && Date.now() - this.lastSeen > HEARTBEAT_TIMEOUT) this.lost('timeout');
    }, HEARTBEAT_INTERVAL);
  }

  // When our own app was in the background its timers and messages were
  // paused too; don't blame the opponent for that silence.
  resumed() {
    this.lastSeen = Date.now();
    this.resumedAt = Date.now();
  }

  // reason: 'left' (they closed the connection or said bye) or 'timeout'
  lost(reason) {
    if (this.ended) return;
    // If *we* were in the background (or only just came back), the opponent
    // most likely gave up on us, not the other way round.
    const weWereAway = document.hidden || Date.now() - (this.resumedAt || 0) < 5000;
    if (reason !== 'you-away' && weWereAway && this.wentAway) reason = 'you-away';
    this.ended = true;
    clearInterval(this.heartbeat);
    this.emit('onDisconnect', reason);
  }

  // ---------- Random matchmaking ----------
  //
  // Each rule set has MATCH_SLOTS well-known peer ids ("waiting spots"). The
  // PeerJS server lets only one peer hold an id, so holding a slot id means
  // "I'm waiting for an opponent". To find a match, try to take each slot in
  // turn: if it's free, wait there; if it's taken, connect to whoever holds
  // it. The waiter is the host of the match; once matched it disconnects from
  // the PeerJS server (which frees the slot id) while keeping the game
  // connection open.

  // Claim-first: taking a free spot is instant, and being refused means
  // someone is waiting there, so connect to them. (Probing an *empty* spot is
  // slow: the PeerJS server holds the offer ~5 s before reporting nobody's
  // there, so only waiters do that, in the background.)
  async matchmake(rules) {
    this.rules = rules;
    this.code = null;
    while (!this.closed && !this.connected) {
      try {
        let probe = null;
        for (let k = 0; k < MATCH_SLOTS && !this.closed && !this.connected; k++) {
          const slot = await this.openPeer(slotId(rules, k));
          if (slot) {
            if (probe) probe.destroy();
            this.waitInSlot(slot, rules, k);
            return;
          }
          probe = probe || (await this.openPeer());
          if (!probe) return; // closed while opening
          if (await this.probeSlots(probe, rules, k + 1, k)) return;
          // That waiter was busy (just matched with someone else): try the next spot.
        }
        if (probe) probe.destroy();
      } catch (err) {
        this.emit('onError', err.type || 'network');
        return;
      }
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000)); // all spots busy; retry
    }
  }

  // Resolves with an open Peer, or null if the id is taken (or we were closed).
  openPeer(id) {
    return new Promise((resolve, reject) => {
      const peer = id ? new Peer(id) : new Peer();
      this.extraPeers.push(peer);
      peer.once('open', () => {
        if (this.closed) {
          peer.destroy();
          resolve(null);
        } else {
          resolve(peer);
        }
      });
      peer.once('error', err => {
        if (!peer.open) {
          peer.destroy();
          if (err.type === 'unavailable-id') resolve(null);
          else reject(err);
        }
      });
    });
  }

  // Connect to whoever holds `targetId`. Resolves with { conn, first } once
  // the waiter confirms the match by sending its 'start' message, or null if
  // nobody is there, they're busy, or it takes too long.
  tryConnect(peer, targetId) {
    return new Promise(resolve => {
      let done = false;
      const conn = peer.connect(targetId, { reliable: true, serialization: 'json' });
      const finish = result => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        peer.off('error', onError);
        if (!result) conn.close();
        resolve(result);
      };
      const onError = err => {
        if (err.type !== 'peer-unavailable' || String(err.message).includes(targetId)) finish(null);
      };
      peer.on('error', onError);
      conn.on('data', msg => {
        if (!done && msg && msg.type === 'start') finish({ conn, first: msg });
      });
      conn.on('close', () => finish(null));
      const timer = setTimeout(() => finish(null), PROBE_TIMEOUT);
    });
  }

  async probeSlots(peer, rules, count, from = 0) {
    for (let k = from; k < count && !this.closed && !this.connected; k++) {
      const found = await this.tryConnect(peer, slotId(rules, k));
      if (found && !this.connected && !this.closed) {
        this.peer = peer;
        this.matched(found.conn, false, found.first);
        return true;
      }
      if (found) found.conn.close();
    }
    return false;
  }

  waitInSlot(peer, rules, k) {
    this.peer = peer;
    peer.on('connection', conn => {
      conn.on('open', () => {
        if (this.connected || this.probing || this.closed) conn.close(); // busy
        else this.matched(conn, true);
      });
    });
    peer.on('error', err => {
      if (!this.connected && !['peer-unavailable'].includes(err.type)) this.emit('onError', err.type);
    });
    // Two players could end up waiting in different slots and never meet, so
    // a waiter regularly checks the slots below its own.
    if (k > 0) {
      this.probeTimer = setInterval(async () => {
        if (this.connected || this.probing || this.closed) return;
        this.probing = true;
        await this.probeSlots(peer, rules, k);
        this.probing = false;
      }, WAITER_PROBE_INTERVAL);
    }
  }

  matched(conn, asHost, firstMessage) {
    clearInterval(this.probeTimer);
    this.isHost = asHost;
    this.connected = true;
    this.attach(conn, { alreadyOpen: true });
    this.startHeartbeat();
    if (asHost) this.peer.disconnect(); // free the slot id; the game connection stays open
    this.emit('onConnect');
    if (firstMessage) this.emit('onMessage', firstMessage);
  }

  send(msg) {
    if (this.connected && !this.closed) this.conn.send(msg);
  }

  emit(name, ...args) {
    if (!this.closed) this.handlers[name](...args);
  }

  close() {
    if (this.connected && !this.closed && !this.ended) {
      try {
        this.conn.send({ type: 'bye' }); // let the opponent know right away
      } catch {}
    }
    this.closed = true;
    clearInterval(this.probeTimer);
    clearInterval(this.heartbeat);
    // A short delay gives the 'bye' a moment to go out before the connection closes.
    const peers = [this.peer, ...this.extraPeers].filter(Boolean);
    setTimeout(() => peers.forEach(peer => peer.destroy()), 200);
  }
}

function slotId(rules, k) {
  return `${PEER_PREFIX}mm-${rules}-${k}`;
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
const findMatchBtn = document.getElementById('find-match');
const lonelyEl = document.getElementById('quick-lonely');
const playNameInput = document.getElementById('player-name');
const nameWarningEl = document.getElementById('name-warning');
const createControlsEl = document.getElementById('create-controls');
const roomInfoEl = document.getElementById('room-info');
const roomCodeEl = document.getElementById('room-code');
const roomQrEl = document.getElementById('room-qr');
const roomQrHintEl = document.querySelector('.room-qr-hint');
const inviteLinkInput = document.getElementById('invite-link');
const copyLinkBtn = document.getElementById('copy-link');
const shareLinkBtn = document.getElementById('share-link');

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
  setLayout({ versus: false, intro: MODES.online.intro, show: 'lobby' });
  resetArena();
  roomInfoEl.hidden = true;
  createControlsEl.hidden = false;
  setLobbyButtons(true);
  findMatchBtn.textContent = 'Find a match';
  clearTimeout(lonelyTimer);
  lonelyEl.hidden = true;
  setLobbyStatus(message);
}

let lonelyTimer = null;

// Enables or disables every lobby action except cancelling a search.
function setLobbyButtons(enabled) {
  createRoomBtn.disabled = !enabled;
  joinRoomBtn.disabled = !enabled;
  findMatchBtn.disabled = !enabled;
}

function searching() {
  return net && net.code === null && !net.connected && !net.closed;
}

// Quick match: toggles between "Find a match" and "Cancel".
function findMatch() {
  if (searching()) {
    leaveOnline();
    showLobby('');
    return;
  }
  if (!peerAvailable()) return;
  leaveOnline();
  net = new OnlineSession(onlineHandlers);
  setLobbyButtons(false);
  findMatchBtn.disabled = false;
  findMatchBtn.textContent = 'Cancel';
  setLobbyStatus('Looking for an opponent…');
  askAboutBotLater(LONELY_AFTER);
  net.matchmake(quickRules());
}

function quickRules() {
  return document.querySelector('input[name="quick-rules"]:checked').value;
}

// If nobody shows up, offer a bot match instead (the search keeps running).
function askAboutBotLater(ms) {
  clearTimeout(lonelyTimer);
  lonelyEl.hidden = true;
  lonelyTimer = setTimeout(() => {
    if (searching()) lonelyEl.hidden = false;
  }, ms);
}

function playBotInstead() {
  const matchRules = quickRules();
  leaveOnline();
  setMode('bot');
  document.querySelector(`input[name="bot-rules"][value="${matchRules}"]`).checked = true;
  startBotMatch();
}

// ---------- Player names ----------

function cleanName(raw) {
  const name = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(name).slice(0, NAME_MAX).join('').trim(); // Array.from keeps emoji whole
}

// The name we send: empty if it's blocked by the word filter.
function myName() {
  const name = cleanName(playNameInput.value);
  return isOffensiveName(name) ? '' : name;
}

// Never trust the other side: clean and filter names we receive too.
function displayName(raw) {
  const name = cleanName(raw);
  return name && !isOffensiveName(name) ? name : null;
}

function updateNameWarning() {
  const name = cleanName(playNameInput.value);
  const blocked = Boolean(name) && isOffensiveName(name);
  nameWarningEl.hidden = !blocked;
  playNameInput.classList.toggle('invalid', blocked);
}

function setOpponentName(name) {
  const opponent = players.find(p => p.remote);
  if (opponent) opponent.view.panelEl.querySelector('.player-name').textContent = name || 'Opponent';
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
  setLobbyButtons(false);
  setLobbyStatus('Creating room…');
  net.host(code => {
    showInvite(code);
    setLobbyStatus('Waiting for your opponent to join…');
  });
}

function inviteLink(code) {
  const local = !location.protocol.startsWith('http') || ['localhost', '127.0.0.1'].includes(location.hostname);
  const base = local ? PUBLIC_URL : location.origin + location.pathname;
  return `${base}#join=${code}`;
}

function showInvite(code) {
  const link = inviteLink(code);
  roomCodeEl.textContent = code;
  inviteLinkInput.value = link;
  renderQr(link);
  shareLinkBtn.hidden = typeof navigator.share !== 'function';
  createControlsEl.hidden = true;
  roomInfoEl.hidden = false;
}

function renderQr(text) {
  const available = typeof qrcode === 'function';
  roomQrEl.hidden = !available;
  roomQrHintEl.hidden = !available;
  if (!available) return;
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  roomQrEl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

async function copyInviteLink() {
  let ok = false;
  try {
    await navigator.clipboard.writeText(inviteLinkInput.value);
    ok = true;
  } catch {
    // Clipboard API can be unavailable (e.g. file://); fall back to a selection copy.
    inviteLinkInput.select();
    ok = document.execCommand('copy');
  }
  copyLinkBtn.textContent = ok ? 'Copied!' : 'Copy failed';
  setTimeout(() => (copyLinkBtn.textContent = 'Copy link'), 1500);
}

function inviteMessage() {
  return `Join my 2048 Stone Clash game! Room ${roomCodeEl.textContent}`;
}

async function shareInviteLink() {
  try {
    await navigator.share({ title: '2048 Stone Clash', text: inviteMessage(), url: inviteLinkInput.value });
  } catch {
    // User closed the share sheet; nothing to do.
  }
}

// ---------- Join by scanning a QR code ----------

// Accepts an invite link (…#join=CODE) or a bare room code.
function roomCodeFrom(text) {
  const value = String(text).trim();
  const match = value.match(/[#?&]join=([A-Za-z0-9]+)/) || value.match(/^([A-Za-z0-9]+)$/);
  const code = match && match[1].toUpperCase();
  return code && code.length === CODE_LENGTH && [...code].every(ch => CODE_CHARS.includes(ch)) ? code : null;
}

function scanToJoin() {
  openScanner(text => {
    const code = roomCodeFrom(text);
    if (!code) return "That QR code isn't a 2048 Stone Clash invite. Try another.";
    joinCodeInput.value = code;
    joinRoom();
    return true;
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
  setLobbyButtons(false);
  setLobbyStatus('Connecting…');
  net.join(code);
}

// Host only: begin a new match for both sides.
function startOnlineRound() {
  round++;
  const seed = randomSeed();
  net.send({ type: 'start', round, seed, rules: net.rules });
  beginOnlineMatch(seed, net.rules);
}

// ---------- Opponent switched to another app ----------

let awayTick = null;

function showOpponentStatus(text) {
  const opponent = players.find(p => p.remote);
  if (!opponent) return;
  const keys = opponent.view.panelEl.querySelector('.keys');
  keys.textContent = text || 'Live view';
  keys.classList.toggle('away', Boolean(text));
}

function opponentAway() {
  clearOpponentAway();
  const deadline = Date.now() + AWAY_TIMEOUT;
  const update = () => {
    const secondsLeft = Math.ceil((deadline - Date.now()) / 1000);
    if (secondsLeft <= 0) endBecauseAway();
    else showOpponentStatus(`Away · ${secondsLeft}s`);
  };
  update();
  awayTick = setInterval(update, 250);
}

function clearOpponentAway() {
  clearInterval(awayTick);
  awayTick = null;
  showOpponentStatus(null);
}

function endBecauseAway() {
  clearOpponentAway();
  const name = net.opponentName;
  net.send({ type: 'bye', reason: 'away' }); // they'll see "you were away too long" when they return
  net.ended = true; // we've said bye ourselves; don't report this as a second disconnect
  leaveOnline();
  outcome = { left: true, reason: 'away', name };
  players.forEach(p => refresh(p));
}

function beginOnlineMatch(seed, matchRules) {
  clearOpponentAway();
  rules = matchRules;
  setLayout({
    versus: true,
    intro: `${RULES[rules]} <span class="room-tag">${net.code ? `Room ${net.code}` : 'Random opponent'}</span>`,
  });
  resetArena();
  const me = addPlayer({
    game: new Game2048(4, seed),
    name: 'You',
    hint: '<strong>Arrow keys</strong>, <strong>WASD</strong> or swipe',
  });
  addPlayer({
    game: new RemoteBoard(4),
    name: net.opponentName || 'Opponent',
    hint: 'Live view',
    remote: true,
  });
  players.forEach(p => refresh(p));
  fitBoard();
  sendState(me, []);
  net.send({ type: 'hello', round, name: myName() });
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

    if (msg.type === 'away') {
      if (!outcome) opponentAway();
      return;
    }
    if (msg.type === 'back') {
      clearOpponentAway();
      return;
    }
    if (msg.type === 'hello') {
      net.opponentName = displayName(msg.name);
      setOpponentName(net.opponentName);
      return;
    }

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

  onDisconnect(reason = 'left') {
    if (awayTick) reason = 'away'; // they went away and never came back
    clearOpponentAway();
    const inMatch = players.length === 2;
    const name = net && net.opponentName;
    leaveOnline();
    if (!inMatch) {
      showLobby(reason === 'timeout' ? 'Lost the connection to your opponent.' : 'Your opponent left.');
      return;
    }
    // Keep both boards on screen and say what happened; play stops.
    outcome = { left: true, reason, name };
    players.forEach(p => refresh(p));
  },

  onError(type) {
    leaveOnline();
    showLobby(ERROR_MESSAGES[type] || `Connection error (${type}).`);
  },
};

createRoomBtn.addEventListener('click', createRoom);
findMatchBtn.addEventListener('click', findMatch);
// Closing or reloading the page: say bye so the opponent knows immediately.
window.addEventListener('pagehide', () => leaveOnline());
document.addEventListener('visibilitychange', () => {
  if (!net || !net.connected) return;
  const inMatch = players.length === 2 && !outcome;
  if (document.hidden) {
    if (inMatch) {
      net.wentAway = true;
      net.send({ type: 'away', round });
    }
  } else {
    net.resumed();
    if (inMatch) net.send({ type: 'back', round });
  }
});
document.getElementById('play-bot-instead').addEventListener('click', playBotInstead);
document.getElementById('keep-waiting').addEventListener('click', () => askAboutBotLater(LONELY_REPEAT));
playNameInput.value = localStorage.getItem(NAME_KEY) || '';
playNameInput.addEventListener('input', () => {
  localStorage.setItem(NAME_KEY, cleanName(playNameInput.value));
  updateNameWarning();
});
playNameInput.addEventListener('change', () => (playNameInput.value = cleanName(playNameInput.value)));
updateNameWarning();
joinRoomBtn.addEventListener('click', joinRoom);
joinCodeInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') joinRoom();
});
copyLinkBtn.addEventListener('click', copyInviteLink);
shareLinkBtn.addEventListener('click', shareInviteLink);
document.getElementById('scan-qr').addEventListener('click', scanToJoin);
inviteLinkInput.addEventListener('focus', () => inviteLinkInput.select());
