// Pure game logic, no DOM access. One instance = one board.

const DIRECTIONS = {
  up: [-1, 0],
  down: [1, 0],
  left: [0, -1],
  right: [0, 1],
};

const WIN_VALUE = 2048;
const STONE_TURNS = 10;

// Small seeded PRNG so two boards given the same seed get the same
// sequence of random spawns (fair multiplayer).
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSeed() {
  return Math.floor(Math.random() * 2 ** 32);
}

class Game2048 {
  constructor(size = 4, seed = randomSeed()) {
    this.size = size;
    this.random = mulberry32(seed);
    this.nextId = 1;
    this.reset();
  }

  reset() {
    this.grid = this.emptyGrid();
    this.score = 0;
    this.won = false;
    this.keepPlaying = false;
    this.over = false;
    this.addRandomTile();
    this.addRandomTile();
  }

  emptyGrid() {
    return Array.from({ length: this.size }, () => Array(this.size).fill(null));
  }

  createTile(value, r, c, flags = {}) {
    return { id: this.nextId++, value, r, c, isNew: false, isMerged: false, ...flags };
  }

  tiles() {
    return this.grid.flat().filter(Boolean);
  }

  emptyCells() {
    const cells = [];
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        if (!this.grid[r][c]) cells.push([r, c]);
      }
    }
    return cells;
  }

  addRandomTile() {
    const cells = this.emptyCells();
    if (cells.length === 0) return;
    const [r, c] = cells[Math.floor(this.random() * cells.length)];
    const value = this.random() < 0.9 ? 2 : 4;
    this.grid[r][c] = this.createTile(value, r, c, { isNew: true });
  }

  // Drops immovable stones on random empty cells. Each stone crumbles after
  // STONE_TURNS of this board's moves. Uses Math.random on purpose so attacks
  // don't shift this board's seeded spawn sequence.
  addStones(count) {
    for (let i = 0; i < count; i++) {
      const cells = this.emptyCells();
      if (cells.length === 0) break;
      const [r, c] = cells[Math.floor(Math.random() * cells.length)];
      this.grid[r][c] = this.createTile(0, r, c, { stone: true, turns: STONE_TURNS, isNew: true });
    }
    if (!this.movesAvailable()) this.over = true;
  }

  inBounds(r, c) {
    return r >= 0 && r < this.size && c >= 0 && c < this.size;
  }

  canMerge(a, b) {
    return a && b && !a.stone && !b.stone && a.value === b.value;
  }

  // Returns { moved, gained, merges, removed }. `merges` lists the values
  // created this move; `removed` are tiles that disappeared (merged away or
  // crumbled stones) with their final position so a view can animate them.
  move(direction) {
    const result = { moved: false, gained: 0, merges: [], removed: [] };
    if (this.isFrozen()) return result;

    const [dr, dc] = DIRECTIONS[direction];
    const order = [...Array(this.size).keys()];
    const rows = dr === 1 ? [...order].reverse() : order;
    const cols = dc === 1 ? [...order].reverse() : order;

    for (const tile of this.tiles()) {
      tile.isNew = false;
      tile.isMerged = false;
    }

    for (const r of rows) {
      for (const c of cols) {
        const tile = this.grid[r][c];
        if (!tile || tile.stone) continue;

        // Slide as far as possible in the direction.
        let pr = r, pc = c;
        let nr = r + dr, nc = c + dc;
        while (this.inBounds(nr, nc) && !this.grid[nr][nc]) {
          pr = nr; pc = nc;
          nr += dr; nc += dc;
        }

        const next = this.inBounds(nr, nc) ? this.grid[nr][nc] : null;
        this.grid[r][c] = null;

        if (this.canMerge(tile, next) && !next.isMerged) {
          const merged = this.createTile(tile.value * 2, nr, nc, { isMerged: true });
          this.grid[nr][nc] = merged;
          tile.r = nr; tile.c = nc;
          result.removed.push(tile, next);
          result.merges.push(merged.value);
          result.gained += merged.value;
          if (merged.value === WIN_VALUE) this.won = true;
          result.moved = true;
        } else {
          this.grid[pr][pc] = tile;
          if (pr !== r || pc !== c) {
            tile.r = pr; tile.c = pc;
            result.moved = true;
          }
        }
      }
    }

    if (result.moved) {
      this.score += result.gained;
      this.tickStones(result.removed);
      this.addRandomTile();
      if (!this.movesAvailable()) this.over = true;
    }
    return result;
  }

  tickStones(removed) {
    for (const tile of this.tiles()) {
      if (!tile.stone) continue;
      tile.turns--;
      if (tile.turns <= 0) {
        this.grid[tile.r][tile.c] = null;
        removed.push(tile);
      }
    }
  }

  // A move in a direction is possible iff some tile's neighbour in that
  // direction is empty or mergeable.
  canMove(direction) {
    const [dr, dc] = DIRECTIONS[direction];
    for (const tile of this.tiles()) {
      if (tile.stone) continue;
      const nr = tile.r + dr, nc = tile.c + dc;
      if (!this.inBounds(nr, nc)) continue;
      const next = this.grid[nr][nc];
      if (!next || this.canMerge(tile, next)) return true;
    }
    return false;
  }

  movesAvailable() {
    return Object.keys(DIRECTIONS).some(dir => this.canMove(dir));
  }

  // Game stops accepting moves when lost, or when won until the player
  // chooses to keep going.
  isFrozen() {
    return this.over || (this.won && !this.keepPlaying);
  }

  serialize() {
    return {
      size: this.size,
      score: this.score,
      won: this.won,
      keepPlaying: this.keepPlaying,
      over: this.over,
      grid: this.grid.map(row => row.map(t => (t && !t.stone ? t.value : 0))),
    };
  }

  static restore(data) {
    const game = new Game2048(data.size);
    game.score = data.score;
    game.won = data.won;
    game.keepPlaying = data.keepPlaying;
    game.over = data.over;
    game.grid = data.grid.map((row, r) =>
      row.map((value, c) => (value ? game.createTile(value, r, c) : null))
    );
    return game;
  }
}
