# Bracket

Bracket gives AI models real tool access — memory, chess, browsing, a second model to consult — through a plain-text command syntax the model can emit in its own replies, with a human approval step before anything runs.

Works across Claude, ChatGPT, DeepSeek, and Gemini, from the same extension.

---

## Why Bracket exists

Most "give the model tools" setups either trust the model completely (autonomous agents that act without a human in the loop) or don't give it real tools at all (just structured text the human has to act on manually). Bracket is built around a middle position: **the model can propose an action, but nothing executes until a human clicks Approve.**

That's not bureaucratic caution bolted on afterward — it's the core design choice everything else follows from:

- The model emits `[(COMMAND {"key":"value"})]` in the normal flow of a reply. No special mode, no separate agent harness.
- Bracket renders that as a card with the parsed params visible, not just the raw text — you can see exactly what will run before it runs.
- One click executes it. The result is staged, then injected into your next message so the model sees it as context on its next turn.
- The model never sees a result until a human has both approved the action *and* pressed Enter to send. Two points of friction, not zero.

This means the model can reach for memory, play out a chess position, fetch a page, or ask a second model for a sanity check — all mid-conversation — without ever being able to act unilaterally.

## How it fits together

```
Bracket/
├── content.js       Watches the chat page, detects commands, renders approval cards
├── background.js    Routes approved commands to the right local tool server
├── server.js         Lifecycle manager (port 2407) — starts/stops tool servers on request
└── servers/
    ├── memory/       Persistent memory: store, search, reconstruct
    ├── chess/        Stockfish-backed board state and analysis
    ├── browse/       Fetch + read a URL
    └── oracle/       A second model (Gemini) for vision, critique, and reasoning
```

Each tool server owns its own command set, its own README, and its own manifest. Bracket's job is discovery and routing — not knowing in advance what tools exist.

## A note on scope

This file is for you, the human — it's never sent to a model. A model only ever sees what `[(SYSTEM)]` returns (a short command primer) or what `[(README {"name":"<tool>"})]` returns (that tool's own `servers/<tool>/README.md`, written directly to the model). If you're editing docs and want a model's behavior to change, the per-tool README is what to touch — this one has no runtime effect at all.

## Where to go from here

- **Setting up, or adding a new tool server?** → [`SETUP_README.md`](./SETUP_README.md)
- **Curious what a specific tool can do?** Read `servers/<tool>/README.md` directly, or have the model run `[(README {"name":"memory"})]` (or `chess`, `browse`, `oracle`) to pull it into the conversation.
- **Something not responding?** Run `[(SERVER_LIST)]` to see what's actually running, or check `SETUP_README.md`'s troubleshooting notes.
