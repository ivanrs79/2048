// Renders a Game2048 into a panel element (score header + board). One view
// per board, so multiplayer is just more BoardView instances.
class BoardView {
  constructor(panelEl, size) {
    this.panelEl = panelEl;
    this.boardEl = panelEl.querySelector('.board');
    this.gridEl = panelEl.querySelector('.grid');
    this.tilesEl = panelEl.querySelector('.tiles');
    this.overlayEl = panelEl.querySelector('.overlay');
    this.overlayText = panelEl.querySelector('.overlay-text');
    this.overlaySub = panelEl.querySelector('.overlay-sub');
    this.keepGoingBtn = panelEl.querySelector('.keep-going');
    this.tryAgainBtn = panelEl.querySelector('.try-again');
    this.scoreEl = panelEl.querySelector('.score');
    this.bestEl = panelEl.querySelector('.best');
    this.elements = new Map();
    this.setSize(size);
  }

  setSize(size) {
    this.boardEl.style.setProperty('--size', size);
    this.gridEl.innerHTML = '';
    for (let i = 0; i < size * size; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      this.gridEl.appendChild(cell);
    }
    this.tilesEl.innerHTML = '';
    this.elements.clear();
  }

  setPlayer(name, keysHint) {
    this.panelEl.querySelector('.player-name').textContent = name;
    this.panelEl.querySelector('.keys').innerHTML = keysHint;
  }

  setScore(score, best) {
    this.scoreEl.textContent = score;
    const showBest = best !== null;
    this.panelEl.querySelector('.best-box').hidden = !showBest;
    if (showBest) this.bestEl.textContent = best;
  }

  render(game, removed = []) {
    const alive = new Set();

    for (const tile of game.tiles()) {
      alive.add(tile.id);
      let el = this.elements.get(tile.id);
      if (!el) {
        el = this.createTileElement(tile);
        this.elements.set(tile.id, el);
        this.tilesEl.appendChild(el);
      }
      if (tile.stone) el.firstChild.textContent = tile.turns;
      this.position(el, tile);
    }

    // Slide merged-away tiles into their target (or crumble stones), then drop them.
    for (const tile of removed) {
      const el = this.elements.get(tile.id);
      if (!el) continue;
      this.elements.delete(tile.id);
      el.classList.add('dying');
      this.position(el, tile);
      setTimeout(() => el.remove(), tile.stone ? 200 : 100);
    }

    for (const [id, el] of this.elements) {
      if (!alive.has(id)) {
        el.remove();
        this.elements.delete(id);
      }
    }
  }

  createTileElement(tile) {
    const el = document.createElement('div');
    el.className = 'tile';
    if (tile.isNew) el.classList.add('new');
    if (tile.isMerged) el.classList.add('merged');

    const inner = document.createElement('div');
    inner.className = 'tile-inner';
    el.appendChild(inner);

    if (tile.stone) {
      el.classList.add('stone');
      el.title = 'Stone: crumbles after this many moves';
      return el;
    }

    if (tile.value > 2048) el.classList.add('super');
    const digits = String(tile.value).length;
    if (digits >= 3) el.classList.add(`digits-${Math.min(digits, 5)}`);
    el.dataset.value = tile.value;
    inner.textContent = tile.value;
    return el;
  }

  position(el, tile) {
    el.style.setProperty('--r', tile.r);
    el.style.setProperty('--c', tile.c);
  }

  // state: null to hide, or { text, sub?, won?, keepGoing?, button? } (no button = none shown)
  setOverlay(state) {
    this.overlayEl.classList.toggle('visible', !!state);
    if (!state) return;
    this.overlayEl.classList.toggle('won', !!state.won);
    this.overlayText.textContent = state.text;
    this.keepGoingBtn.hidden = !state.keepGoing;
    this.overlaySub.textContent = state.sub || '';
    this.overlaySub.hidden = !state.sub;
    this.tryAgainBtn.hidden = !state.button;
    this.tryAgainBtn.textContent = state.button || '';
  }
}

// ---------- Match setup ----------

const STATE_KEY = 'game2048-state';
const BEST_KEY = 'game2048-best';
const MODE_KEY = 'game2048-mode';
const ATTACK_MIN = 64;

const KEYS = {
  ArrowUp: 'up', ArrowLeft: 'left', ArrowDown: 'down', ArrowRight: 'right',
  KeyW: 'up', KeyA: 'left', KeyS: 'down', KeyD: 'right',
};

// Online match rules, chosen by the host.
const RULES = {
  race: 'First to <strong>2048</strong> wins. Get stuck and you lose!',
  attack: `Merge <strong>${ATTACK_MIN}+</strong> to drop stones on your rival. First to 2048 or last one standing wins!`,
};

const MODES = {
  solo: { intro: 'Join the tiles, get to <strong>2048!</strong>' },
  bot: { intro: 'Play against the computer.' },
  online: { intro: 'Play online against a random opponent or a friend.' },
};

const containerEl = document.getElementById('container');
const arenaEl = document.getElementById('arena');
const introEl = document.getElementById('intro');
const newGameBtn = document.getElementById('new-game');
const template = document.getElementById('panel-template');

let mode = null;
let rules = null; // null (solo), or the online match's 'race' / 'attack'
let players = []; // solo: [me]; online: [me, opponent]
let outcome = null; // online only: null while playing, then { winner } or { draw: true }
let net = null; // OnlineSession while in online mode (see online.js)
let best = Number(localStorage.getItem(BEST_KEY)) || 0;

function loadSoloGame() {
  try {
    const data = JSON.parse(localStorage.getItem(STATE_KEY));
    return data ? Game2048.restore(data) : null;
  } catch {
    return null;
  }
}

function setMode(newMode, { restore = false } = {}) {
  if (newMode === 'online' && mode === 'online' && net) return; // don't drop a live connection
  if (net) {
    net.close();
    net = null;
  }
  mode = newMode;
  localStorage.setItem(MODE_KEY, mode);
  for (const btn of document.querySelectorAll('.mode-btn')) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  }
  if (mode === 'online') showLobby();
  else if (mode === 'bot') showBotSetup();
  else startSolo(restore);
}

// show: which main area is visible: 'arena' (boards), 'lobby' (online) or 'bot' (bot setup)
function setLayout({ versus, intro, show = 'arena' }) {
  containerEl.classList.toggle('versus', versus);
  arenaEl.classList.toggle('versus', versus);
  introEl.innerHTML = intro;
  lobbyEl.hidden = show !== 'lobby';
  botSetupEl.hidden = show !== 'bot';
  arenaEl.hidden = show !== 'arena';
  newGameBtn.hidden = show !== 'arena';
  newGameBtn.textContent = mode === 'online' ? 'Restart' : 'New Game';
}

function resetArena() {
  stopBot();
  arenaEl.innerHTML = '';
  players = [];
  outcome = null;
}

function addPlayer({ game, name, hint, remote = false }) {
  const panelEl = template.content.firstElementChild.cloneNode(true);
  panelEl.classList.add(remote ? 'opponent' : 'me');
  arenaEl.appendChild(panelEl);

  const view = new BoardView(panelEl, game.size);
  const player = { index: players.length, game, view, remote };
  view.setPlayer(name, hint);

  addSwipe(view.boardEl, dir => move(player, dir));
  view.keepGoingBtn.addEventListener('click', () => {
    player.game.keepPlaying = true;
    refresh(player);
  });
  view.tryAgainBtn.addEventListener('click', newGame);

  players.push(player);
  return player;
}

function startSolo(restore = false) {
  rules = null;
  setLayout({ versus: false, intro: MODES.solo.intro });
  resetArena();
  const player = addPlayer({
    game: (restore && loadSoloGame()) || new Game2048(4),
    name: '',
    hint: 'Use <strong>arrow keys</strong> or <strong>WASD</strong> to move. On touch screens, swipe.',
  });
  refresh(player);
  fitBoard();
}

// On short screens (e.g. older phones), shrink your board so the whole page
// fits without scrolling. The board is square and nothing else depends on its
// size, so shrinking it by the page's overflow makes the page fit exactly.
// The CSS size is the upper limit; this only ever shrinks.
const MIN_BOARD = 220;

function fitBoard() {
  const me = players.find(p => !p.remote);
  if (!me) return;
  const { panelEl, boardEl } = me.view;
  panelEl.style.removeProperty('--board');
  const width = boardEl.getBoundingClientRect().width;
  const overflow = Math.ceil(document.documentElement.scrollHeight - window.innerHeight);
  if (overflow > 0) {
    panelEl.style.setProperty('--board', `${Math.max(MIN_BOARD, Math.floor(width - overflow))}px`);
  }
}

window.addEventListener('resize', fitBoard);

function newGame() {
  if (mode === 'online') {
    if (net && net.connected) requestRematch();
    else showLobby(''); // the opponent left: back to the lobby
  }
  else if (mode === 'bot') startBotMatch();
  else startSolo();
}

// ---------- Turn handling ----------

// From keyboard / swipe input: only your own board can be moved.
function move(player, direction) {
  if (!player.remote) playMove(player, direction);
}

// Applies a move for any player (you, or the bot) and resolves its effects.
function playMove(player, direction) {
  if (outcome) return;
  const result = player.game.move(direction);
  if (!result.moved) return;

  const stones = rules === 'attack' ? result.merges.filter(v => v >= ATTACK_MIN).length : 0;
  const opponent = players[1 - player.index];
  if (net) {
    onlineMoved(player, result.removed, stones);
  } else if (opponent) {
    // Bot match: both boards are local.
    if (stones > 0) opponent.game.addStones(stones);
    judge();
  }

  refresh(player, result.removed);
  if (opponent) refresh(opponent);
}

function judge() {
  const reached = players.find(p => p.game.won);
  if (reached) {
    outcome = { winner: reached.index };
    return;
  }
  const stuck = players.filter(p => p.game.over);
  if (stuck.length === 1) {
    outcome = { winner: 1 - stuck[0].index };
  } else if (stuck.length === 2) {
    const [a, b] = players.map(p => p.game.score);
    outcome = a === b ? { draw: true } : { winner: a > b ? 0 : 1 };
  }
}

function overlayFor(player) {
  const { game } = player;
  if (players.length === 1) {
    if (game.won && !game.keepPlaying) {
      return { text: 'You win!', won: true, keepGoing: true, button: 'Try again' };
    }
    if (game.over) return { text: 'Game over!', button: 'Try again' };
    return null;
  }
  if (!outcome) return null;
  if (outcome.left) {
    return player.remote
      ? { text: 'Left' }
      : { text: 'Opponent left', sub: `${outcome.name || 'Your opponent'} left the game.`, button: 'Back to lobby' };
  }
  if (outcome.draw) return { text: 'Draw!', button: 'Rematch' };
  if (outcome.winner === player.index) return { text: 'Winner!', won: true, button: 'Rematch' };
  return { text: game.over ? 'Stuck!' : 'Too slow!', button: 'Rematch' };
}

function refresh(player, removed) {
  const solo = players.length === 1;
  player.view.render(player.game, removed);

  if (solo) {
    if (player.game.score > best) {
      best = player.game.score;
      localStorage.setItem(BEST_KEY, best);
    }
    localStorage.setItem(STATE_KEY, JSON.stringify(player.game.serialize()));
  }

  player.view.setScore(player.game.score, solo ? best : null);
  player.view.setOverlay(overlayFor(player));
}

// ---------- Input ----------

document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target instanceof HTMLInputElement) return;
  const direction = KEYS[e.code];
  const me = players.find(p => !p.remote);
  if (!direction || !me) return;
  e.preventDefault();
  move(me, direction);
});

function addSwipe(el, onSwipe) {
  let start = null;
  el.addEventListener('pointerdown', e => {
    start = { x: e.clientX, y: e.clientY };
  });
  el.addEventListener('pointerup', e => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    start = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 30) return;
    if (Math.abs(dx) > Math.abs(dy)) onSwipe(dx > 0 ? 'right' : 'left');
    else onSwipe(dy > 0 ? 'down' : 'up');
  });
}

for (const btn of document.querySelectorAll('.mode-btn')) {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
}
newGameBtn.addEventListener('click', newGame);

// Invite links look like index.html#join=ABCDE
function joinFromInvite() {
  const invite = location.hash.match(/^#join=(\w+)$/);
  if (!invite) return false;
  history.replaceState(null, '', location.pathname + location.search);
  leaveOnline();
  setMode('online');
  joinCodeInput.value = invite[1].toUpperCase();
  joinRoom();
  return true;
}

window.addEventListener('hashchange', joinFromInvite);

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js');
}

if (!joinFromInvite()) {
  const saved = localStorage.getItem(MODE_KEY);
  setMode(MODES[saved] ? saved : 'solo', { restore: true });
}
