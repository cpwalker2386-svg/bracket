# Bracket

A unified browser extension that gives AI models tool capabilities through bracket commands.
Works on Claude, ChatGPT, DeepSeek, and Gemini.

---

## Architecture

```
Bracket/
├── manifest.json          Chrome extension manifest
├── content.js             Watches chat UIs, renders approval cards, injects results
├── background.js          Routes commands to the correct tool server by port
├── popup.html / popup.js  Status panel showing which servers are online
├── server.js              Lifecycle manager (port 2407) — start/stop tool servers
└── servers/
    ├── memory/server.js   Memory tool (port 2408)
    ├── chess/server.js    Chess + Stockfish tool (port 2409)
    └── browse/server.js   Browse/fetch tool (port 2410)
```

**Flow:**
1. AI outputs a `[(COMMAND {"key":"value"})]` bracket command
2. `content.js` detects it, renders an approval card
3. User clicks **Approve** — command routes through `background.js` to the correct server
4. Result is staged; next **Enter** keypress injects it at the top of the message input
5. The AI receives the result in its context on the following turn

---

## Quick Start

### 1. Load the extension
1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `Bracket` folder

### 2. Start the lifecycle manager
```bash
node server.js
```
Leave this running. It manages tool servers on demand.

### 3. Start the tools you need
Either start them manually:
```bash
node servers/memory/server.js
node servers/chess/server.js
node servers/browse/server.js
```

Or use lifecycle commands inside any AI chat:

```
[(SERVER_START {"name":"memory"})]
[(SERVER_START {"name":"chess"})]
[(SERVER_START {"name":"browse"})]
[(SERVER_LIST)]
```

---

## Commands

### Memory (port 2408)

| Command | Params | Description |
|---------|--------|-------------|
| `[(STORE {…})]` | `tags, recipe, confidence, importance, model` | Save a memory |
| `[(SEARCH {…})]` | `tags, since, until, min_confidence, limit` | Find memories |
| `[(READ {…})]` | `id` | Read a memory (with required memories) |
| `[(UPDATE {…})]` | `id, tags?, recipe?, confidence?, …` | Update fields |
| `[(LIST {…})]` | `limit?` | List recent memories |
| `[(TAGINDEX)]` | — | Show all tags with counts and dates |

Memory files are stored at `../AI_Memory/memories/` relative to the servers/memory directory.
Override with the `MEMORY_ROOT` environment variable.

### Chess (port 2409)

| Command | Params | Description |
|---------|--------|-------------|
| `[(BOARD)]` | — | Show board + FEN + turn |
| `[(MOVES)]` | — | All legal moves |
| `[(MOVE {…})]` | `san` or `uci` | Play a move |
| `[(RECOMMENDATION)]` | — | Stockfish eval (async) |
| `[(DEPTH {…})]` | `level` (1–30) | Set search depth |
| `[(RESETBOARD)]` | — | Reset to starting position |

Chess requires a `chess-local` directory with `chess.js` and `stockfish` installed.
Set the `CHESS_LOCAL` environment variable to point to it:
```bash
# Windows
set CHESS_LOCAL=D:\chess-local\chess-local

# macOS / Linux
export CHESS_LOCAL=/opt/chess-local
```

### Browse (port 2410)

| Command | Params | Description |
|---------|--------|-------------|
| `[(BROWSE {…})]` | `url` | Fetch a URL and return plain text |

Works with Node 18+ built-in fetch. For JS-rendered pages, install puppeteer and update `servers/browse/server.js`.

### Lifecycle (port 2407)

| Command | Params | Description |
|---------|--------|-------------|
| `[(SERVER_LIST)]` | — | Show running/stopped tools |
| `[(SERVER_START {…})]` | `name` | Start a tool server |
| `[(SERVER_STOP {…})]` | `name` | Stop a tool server |

---

## Adding a New Tool

1. Create `servers/<toolname>/server.js` listening on a new port
2. Add its commands to `TOOL_ROUTES` in `background.js`
3. Add a tool entry to `TOOLS` in `content.js`
4. Add the tool to `TOOLS` in `server.js` (lifecycle)
5. Add a status row to `popup.html` / `popup.js`

That's it — the extension will automatically route commands to the new server.

---

## Toggle

Each page has a `[ ] BRACKET ON` badge in the bottom-right corner.
Click it to disable command interception without unloading the extension.

---

## Result Injection

Results are staged after Approve is clicked.
The **next Enter keypress** in the chat input injects them as a `[Memory Results] … [/Memory Results]` block at the top of your message.

This gives you a moment to type context before sending, and ensures the AI always receives the result clearly labeled.
