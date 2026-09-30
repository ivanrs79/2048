// Computer opponent. The AI works on plain value grids (0 = empty,
// -1 = stone), so its look-ahead never touches the real game's seeded spawns
// and it can't see which tiles are coming.

// depth: how many future tile spawns the bot considers (0 = judge the board
// right after its move); samples: empty cells tried per spawn (look-ahead cost
// grows with samples^depth, which matters on older phones); randomness:
// chance of playing a random legal move.
const BOT_LEVELS = {
  easy: { label: 'Easy', delay: 1100, depth: 0, samples: 0, randomness: 0.3 },
  medium: { label: 'Medium', delay: 750, depth: 1, samples: 6, randomness: 0.03 },
  hard: { label: 'Hard', delay: 450, depth: 1, samples: 6, randomness: 0 },
};
const BOT_SETTINGS_KEY = 'game2048-bot';
const BOT_DIRECTIONS = ['up', 'down', 'left', 'right'];

function gridOf(game) {
  return game.grid.map(row => row.map(t => (!t ? 0 : t.stone ? -1 : t.value)));
}

// Cells of each row/column, ordered from the wall tiles slide towards.
function linesFor(size, direction) {
  const idx = [...Array(size).keys()];
  const rev = [...idx].reverse();
  if (direction === 'left') return idx.map(r => idx.map(c => [r, c]));
  if (direction === 'right') return idx.map(r => rev.map(c => [r, c]));
  if (direction === 'up') return idx.map(c => idx.map(r => [r, c]));
  return idx.map(c => rev.map(r => [r, c]));
}

// Same rules as Game2048.move: tiles slide until a wall, stone or tile, and
// each tile merges at most once per move.
function slideGrid(grid, direction) {
  const out = grid.map(row => row.slice());
  let moved = false;
  for (const line of linesFor(grid.length, direction)) {
    const values = line.map(([r, c]) => grid[r][c]);
    const result = values.map(v => (v === -1 ? -1 : 0));
    let target = 0;
    let last = -1; // index of the last placed tile that may still merge
    values.forEach((v, i) => {
      if (v === -1) {
        target = i + 1;
        last = -1;
      } else if (v > 0) {
        if (last >= 0 && result[last] === v) {
          result[last] = v * 2;
          last = -1;
        } else {
          result[target] = v;
          last = target;
          target++;
        }
      }
    });
    line.forEach(([r, c], i) => {
      if (out[r][c] !== result[i]) moved = true;
      out[r][c] = result[i];
    });
  }
  return { grid: out, moved };
}

// Board score, adapted from the well-known 2048 expectimax heuristic
// (nneonneo/2048-ai): per row and column, reward empty cells and possible
// merges, penalise lines that aren't ordered (monotonic) and large scattered
// tiles. Works on tile ranks (log2), so 2048 counts as 11.
function scoreLine(line) {
  const ranks = line.map(v => (v > 0 ? Math.log2(v) : 0));
  let sum = 0, empty = 0, merges = 0, prev = -1, counter = 0;
  line.forEach((v, i) => {
    const rank = ranks[i];
    sum += rank ** 3.5;
    if (v === 0) {
      empty++;
    } else if (v === -1) {
      prev = -1; // stones break up merge runs
    } else {
      if (prev === rank) {
        counter++;
      } else if (counter > 0) {
        merges += 1 + counter;
        counter = 0;
      }
      prev = rank;
    }
  });
  if (counter > 0) merges += 1 + counter;
  let monoLeft = 0, monoRight = 0;
  for (let i = 1; i < ranks.length; i++) {
    const a = ranks[i - 1] ** 4, b = ranks[i] ** 4;
    if (a > b) monoLeft += a - b;
    else monoRight += b - a;
  }
  return 200000 + 270 * empty + 700 * merges - 47 * Math.min(monoLeft, monoRight) - 11 * sum;
}

// The same few thousand lines come up over and over, so remember their scores.
const lineScores = new Map();

function cachedLineScore(line) {
  const key = line.join(',');
  let score = lineScores.get(key);
  if (score === undefined) {
    score = scoreLine(line);
    lineScores.set(key, score);
  }
  return score;
}

function evaluate(grid) {
  const size = grid.length;
  let score = 0;
  for (let i = 0; i < size; i++) {
    score += cachedLineScore(grid[i]);
    score += cachedLineScore(grid.map(row => row[i]));
  }
  return score;
}

// Expected score of a board right after the bot moved, looking `depth` tile
// spawns ahead: average over where the next tile may appear (sampled), and
// assume the bot then plays its best move.
function expectimax(grid, depth, samples) {
  if (depth === 0) return evaluate(grid);
  const empty = [];
  grid.forEach((row, r) => row.forEach((v, c) => v === 0 && empty.push([r, c])));
  if (empty.length === 0) return evaluate(grid);
  const sample = empty.sort(() => Math.random() - 0.5).slice(0, samples);
  let total = 0;
  for (const [r, c] of sample) {
    for (const [value, p] of [[2, 0.9], [4, 0.1]]) {
      const g = grid.map(row => row.slice());
      g[r][c] = value;
      let best = 0; // 0 = stuck, far below any real board score
      for (const dir of BOT_DIRECTIONS) {
        const next = slideGrid(g, dir);
        if (next.moved) best = Math.max(best, expectimax(next.grid, depth - 1, samples));
      }
      total += p * best;
    }
  }
  return total / sample.length;
}

function chooseBotMove(game, level) {
  const grid = gridOf(game);
  const options = BOT_DIRECTIONS
    .map(dir => ({ dir, ...slideGrid(grid, dir) }))
    .filter(o => o.moved);
  if (options.length === 0) return null;
  if (Math.random() < level.randomness) {
    return options[Math.floor(Math.random() * options.length)].dir;
  }
  let best = options[0];
  let bestScore = -Infinity;
  for (const o of options) {
    const score = expectimax(o.grid, level.depth, level.samples);
    if (score > bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return best.dir;
}

// ---------- Bot setup screen & match ----------

const botSetupEl = document.getElementById('bot-setup');
const startBotBtn = document.getElementById('start-bot');

let botTimer = null;

function loadBotSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(BOT_SETTINGS_KEY));
    if (saved && RULES[saved.rules] && BOT_LEVELS[saved.level]) return saved;
  } catch {}
  return { rules: 'race', level: 'medium' };
}

function showBotSetup() {
  stopBot();
  setLayout({ versus: false, intro: MODES.bot.intro, show: 'bot' });
  resetArena();
  const { rules: savedRules, level } = loadBotSettings();
  document.querySelector(`input[name="bot-rules"][value="${savedRules}"]`).checked = true;
  document.querySelector(`input[name="bot-level"][value="${level}"]`).checked = true;
}

function startBotMatch() {
  const settings = {
    rules: document.querySelector('input[name="bot-rules"]:checked').value,
    level: document.querySelector('input[name="bot-level"]:checked').value,
  };
  localStorage.setItem(BOT_SETTINGS_KEY, JSON.stringify(settings));
  const level = BOT_LEVELS[settings.level];

  stopBot();
  rules = settings.rules;
  setLayout({
    versus: true,
    intro: `${RULES[rules]} <span class="room-tag">Bot · ${level.label}</span>`,
  });
  resetArena();
  const seed = randomSeed();
  addPlayer({
    game: new Game2048(4, seed),
    name: 'You',
    hint: '<strong>Arrow keys</strong>, <strong>WASD</strong> or swipe',
  });
  const bot = addPlayer({
    game: new Game2048(4, seed),
    name: `Bot · ${level.label}`,
    hint: 'Computer opponent',
    remote: true,
  });
  players.forEach(p => refresh(p));
  fitBoard();

  botTimer = setInterval(() => {
    if (outcome) return stopBot();
    if (document.hidden) return; // don't let the bot play while the app is in the background
    const dir = chooseBotMove(bot.game, level);
    if (dir) playMove(bot, dir);
  }, level.delay);
}

function stopBot() {
  clearInterval(botTimer);
  botTimer = null;
}

startBotBtn.addEventListener('click', startBotMatch);
