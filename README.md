# 2048 Stone Clash Multiplayer

The classic 2048 puzzle in the browser, with online multiplayer. Installable as an app (PWA), and packaged for Android as a Trusted Web Activity.

**Play:** https://ivanrs79.github.io/2048/

## Modes

- **Solo**: classic 2048. Your best score and current game are saved.
- **Bot**: play Race or Attack (below) against the computer at Easy, Medium or Hard. The bot runs on your device and can't see upcoming tiles.
- **Online**: **Quick match** pairs you with a random player who is searching right now (no server needed: waiting players hold well-known PeerJS ids), or create a room and invite a friend with the link, QR code or 5-character code. You play peer-to-peer via [PeerJS](https://peerjs.com/), with your opponent's board shown live next to yours. The host picks the rules:
  - **Race**: the first to reach 2048 wins; get stuck and you lose.
  - **Attack**: every merge of 64 or higher drops a stone on your rival's board. Stones can't move or merge and crumble after 10 moves. First to 2048 or last one standing wins.

Both boards get the same sequence of new tiles, so skill decides.

Controls: arrow keys, W A S D, or swipe.

## Run locally

No build step: open `index.html` in a browser. Online mode needs an internet connection. The offline cache (service worker) only runs when the site is served over http(s).

## Files

- `game.js`: game rules (no DOM)
- `main.js`: rendering, input, solo mode
- `online.js`: PeerJS networking and lobby
- `bot.js`: computer opponent (expectimax search) and its setup screen
- `index.html`, `style.css`: page and styles
- `manifest.webmanifest`, `sw.js`, `icons/`: installable app + offline support
- `privacy.html`: privacy policy
- `vendor/`: [PeerJS](https://github.com/peers/peerjs) 1.5.4 and [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 (both MIT), bundled so the app works offline and can be packaged for app stores
