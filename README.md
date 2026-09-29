# 2048

The classic 2048 puzzle in the browser, with online multiplayer.

**Play:** https://ivanrs79.github.io/2048/

## Modes

- **Solo**: classic 2048. Your best score and current game are saved.
- **Online**: create a room and invite a friend with the link, QR code or 5-character code. You play peer-to-peer via [PeerJS](https://peerjs.com/), with your opponent's board shown live next to yours. The host picks the rules:
  - **Race**: the first to reach 2048 wins; get stuck and you lose.
  - **Attack**: every merge of 64 or higher drops a stone on your rival's board. Stones can't move or merge and crumble after 10 moves. First to 2048 or last one standing wins.

Both boards get the same sequence of new tiles, so skill decides.

Controls: arrow keys, W A S D, or swipe.

## Run locally

No build step or dependencies: open `index.html` in a browser. Online mode needs an internet connection.

## Files

- `game.js`: game rules (no DOM)
- `main.js`: rendering, input, local modes
- `online.js`: PeerJS networking and lobby
- `index.html`, `style.css`: page and styles
