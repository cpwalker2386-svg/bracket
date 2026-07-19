# Bracket — Setup

For what Bracket is and why it's built this way, see [`README.md`](./README.md). This file is just install steps and how to extend it.

---

## 1. Load the extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `Bracket` folder

Any time you change `content.js`, `background.js`, or `manifest.json`, you need to hit the reload icon on the Bracket card in `chrome://extensions` — extension code does not hot-reload. Reload the chat tab afterward too, so `content.js` picks up a fresh service worker.

## 2. Set up API keys (if using Oracle or Memory)

Create a `.env` file at the repo root:
```
GEMINI_API_KEY=your_key_here
```
Get a free key at https://aistudio.google.com/apikey

## 3. Start the lifecycle manager

```bash
node server.js
```

Leave this running. It scans `servers/` on startup, loads each tool's `manifest.json`, and exposes `SERVER_START` / `SERVER_STOP` / `SERVER_LIST` to bring individual tool servers up and down. It does **not** watch the directory live — if you add a new tool folder while it's running, restart it to pick up the new manifest.

## 4. Start the tools you need

Either manually:
```bash
node servers/memory/server.js
node servers/chess/server.js
node servers/browse/server.js
node servers/oracle/server.js
```

Or let the model do it — Bracket renders an approval card for each of these like any other command:
```
[(SYSTEM)]
[(SERVER_START {"name":"memory"})]
[(SERVER_START {"name":"chess"})]
[(SERVER_START {"name":"browse"})]
[(SERVER_START {"name":"oracle"})]
[(SERVER_LIST)]
```
You can't type these yourself in the chat box — Bracket only intercepts commands the *model* outputs, then asks you to approve them.

### Per-tool dependencies

Chess needs local packages installed before it'll start:
```bash
cd servers/chess
npm install chess.js stockfish
```
Browse works with Node 18+'s built-in `fetch` out of the box; for JS-rendered pages you'd need to add puppeteer yourself.

---

## Adding a new tool server

Bracket discovers tools by scanning `servers/` for folders containing a `manifest.json` — nothing else needs to know a new tool exists. To add one:

1. Create `servers/<toolname>/server.js` — an HTTP server listening on a port you choose (check `servers/*/manifest.json` for ports already in use; lifecycle is `2407`).
2. Create `servers/<toolname>/manifest.json` declaring:
   - `port` — must match what `server.js` listens on
   - `routes` — map of `COMMAND_NAME` → endpoint path (e.g. `"ASK": "/ask"`)
   - `ui` — `label`, `icon`, `colors`, and optionally `asyncCommands` / `asyncLoadingText` / `asyncReadyText` for long-running commands
   - `requires_key` (optional) — name of an env var this tool needs set
   - `popup` (optional) — grouping info for the extension's status popup
3. Create `servers/<toolname>/README.md` — model-facing docs for this tool's commands. This is what `[(README {"name":"<toolname>"})]` returns, so write it *to* the model, not about the tool.
4. Restart `node server.js` (lifecycle manager) so it picks up the new manifest, then reload the extension and the chat tab.

That's it. No editing `background.js`, `content.js`, or `server.js` — `TOOL_ROUTES`, `ACTION_TO_TOOL`, and the lifecycle's `TOOLS` registry are all built dynamically from manifests at load time. If you find yourself hand-editing any of those three files to add a tool, something's wrong — the whole point of the manifest system is that you shouldn't have to.

A folder without a valid `manifest.json` is skipped with a `WARNING` in the lifecycle server's log, not an error — check there first if a new tool isn't showing up.

---

## Troubleshooting

- **Command doesn't render a card at all**: check the extension's service worker console (`chrome://extensions` → Bracket → "Inspect views: service worker") for `[Bracket]`-prefixed warnings. If manifests failed to load once, they should now retry automatically rather than caching the failure — if you're on an older build, pull latest.
- **Card renders but Approve errors with "server unreachable"**: that specific tool's server isn't running. `[(SERVER_LIST)]` to confirm, `[(SERVER_START {"name":"..."})]` to bring it up.
- **Lifecycle itself unreachable**: `node server.js` isn't running, or crashed. Check its terminal output.
- **New tool folder not appearing**: restart the lifecycle manager — it only scans `servers/` at startup, not live.

## Result injection

Results are staged after Approve is clicked. The **next Enter keypress** in the chat input injects them as a `[Memory Results] … [/Memory Results]` block at the top of your message — giving you a moment to add context before sending, and ensuring the model always receives the result clearly labeled.
