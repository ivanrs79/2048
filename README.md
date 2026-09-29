# 2048

The classic 2048 puzzle in the browser, with two-player modes.

**Play:** https://ivanrs79.github.io/2048/

## Modes

- **Solo**: classic 2048. Your best score and current game are saved.
- **2P Race** (same keyboard): the first player to reach 2048 wins; get stuck and you lose. Player 1 uses W A S D, Player 2 uses the arrow keys.
- **2P Attack** (same keyboard): every merge of 64 or higher drops a stone on your rival's board. Stones can't move or merge and crumble after 10 moves.
- **Online**: create a room, share the 5-character code or invite link, and play Race or Attack against a friend over the internet (peer-to-peer via [PeerJS](https://peerjs.com/)).

In two-player modes both boards get the same sequence of new tiles, so skill decides.

## Run locally

No build step or dependencies: open `index.html` in a browser. Online mode needs an internet connection.

## Files

- `game.js`: game rules (no DOM)
- `main.js`: rendering, input, local modes
- `online.js`: PeerJS networking and lobby
- `index.html`, `style.css`: page and styles
