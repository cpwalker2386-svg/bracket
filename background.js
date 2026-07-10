'use strict';

// ─── Tool Registry (dynamic) ───────────────────────────────────────────────────
// Lifecycle server (port 2407) is the source of truth for what tools exist.
// This only hardcodes lifecycle's own routes — everything else is fetched.

const LIFECYCLE_ROUTES = {
  SYSTEM:       { port: 2407, endpoint: '/system' },
  README:       { port: 2407, endpoint: '/readme' },
  SERVER_START: { port: 2407, endpoint: '/start' },
  SERVER_STOP:  { port: 2407, endpoint: '/stop' },
  SERVER_LIST:  { port: 2407, endpoint: '/list' },
};

let manifestCache = null;      // raw per-tool manifest data (routes/ui/popup/requires_key)
let TOOL_ROUTES = { ...LIFECYCLE_ROUTES }; // flat COMMAND -> {port, endpoint}
let manifestLoadPromise = null;

async function loadManifests(force = false) {
  if (manifestCache && !force) return manifestCache;
  if (manifestLoadPromise && !force) return manifestLoadPromise;

  manifestLoadPromise = fetch('http://localhost:2407/manifests')
    .then(r => { if (!r.ok) throw new Error('status ' + r.status); return r.json(); })
    .then(manifests => {
      manifestCache = manifests;
      TOOL_ROUTES = { ...LIFECYCLE_ROUTES };
      for (const [name, tool] of Object.entries(manifests)) {
        for (const [action, endpoint] of Object.entries(tool.routes)) {
          TOOL_ROUTES[action] = { port: tool.port, endpoint };
        }
      }
      return manifestCache;
    })
    .catch(err => {
      console.warn('[Bracket] Could not load tool manifests — is lifecycle running?', err.message);
      manifestCache = {};
      return manifestCache;
    });

  return manifestLoadPromise;
}

// Kick off a load at service-worker startup; individual commands still
// await loadManifests() so a cold-start race never drops a command.
loadManifests();

// ─── Command Parser ───────────────────────────────────────────────────────────

function parseCommand(raw) {
  const trimmed = raw.trim();
  const match = trimmed.match(/^([\w]+)\s*(\{[\s\S]*\})?$/);
  if (!match) return null;

  const action = match[1].toUpperCase();
  let params = {};

  if (match[2]) {
    try {
      params = JSON.parse(match[2]);
    } catch (e) {
      return { error: 'Invalid JSON in command: ' + e.message };
    }
  }

  return { action, params };
}

// ─── Result Formatter (Memory READ) ──────────────────────────────────────────

function formatReadResult(rawJSON) {
  try {
    const parsed = JSON.parse(rawJSON);
    if (!parsed.memory || !parsed.requires_content) return rawJSON;

    let output = `RECIPE: ${parsed.memory.recipe}\n`;
    output += `TAGS: ${parsed.memory.tags.join(', ')}\n`;
    output += `CONFIDENCE: ${parsed.memory.confidence} · IMPORTANCE: ${parsed.memory.importance}\n`;
    output += `MODEL: ${parsed.memory.model}\n`;

    if (parsed.memory.pointers && parsed.memory.pointers.length > 0) {
      output += `POINTERS: ${parsed.memory.pointers.join(', ')}\n`;
    }

    if (parsed.requires_content.length > 0) {
      output += `\n─── Required Memories (${parsed.requires_content.length}) ───\n`;
      for (const req of parsed.requires_content) {
        if (req.error) {
          output += `\n⚠ ${req.file}: ${req.error}`;
        } else {
          output += `\n▶ ${req.file}\n   ${req.recipe}\n   Tags: ${req.tags.join(', ')} · Confidence: ${req.confidence} · Importance: ${req.importance}`;
        }
      }
    }
    return output;
  } catch {
    return rawJSON;
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Handle POLL_STEAM before looking for msg.command
  if (msg.type === 'POLL_STEAM') {
    pollSteam().then(() => {
      getLastGame().then(game => {
        if (game) {
          sendResponse({ game });
        } else {
          sendResponse({ cleared: true });
        }
      });
    }).catch(() => {
      sendResponse({ cleared: true });
    });
    return true; // keep the message channel open for async response
  }

  // Manifests / UI data, requested by content.js and popup.js
  if (msg.type === 'GET_MANIFESTS') {
    loadManifests().then((manifests) => {
      sendResponse({ manifests });
    });
    return true;
  }

  // Server-side key status (which required keys are set in .env)
  if (msg.type === 'GET_KEY_STATUS') {
    fetch('http://localhost:2407/keys')
      .then(r => r.json())
      .then(status => sendResponse({ status }))
      .catch(err => sendResponse({ error: 'Lifecycle unreachable — ' + err.message }));
    return true;
  }

  // Set a server-side key (writes to root .env via lifecycle)
  if (msg.type === 'SET_KEY') {
    fetch('http://localhost:2407/set-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: msg.key, value: msg.value }),
    })
      .then(r => r.json())
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ ok: false, error: 'Lifecycle unreachable — ' + err.message }));
    return true;
  }

  if (!msg.command) return;

  loadManifests().then(() => {
    const parsed = parseCommand(msg.command);

    if (!parsed) {
      sendResponse({ error: 'Could not parse command: ' + msg.command });
      return;
    }

    if (parsed.error) {
      sendResponse({ error: parsed.error });
      return;
    }

    const { action, params } = parsed;
    const route = TOOL_ROUTES[action];

    if (!route) {
      const validCmds = [...new Set(Object.keys(TOOL_ROUTES))];
      sendResponse({
        error: `Unknown command: ${action}. Valid commands: ${validCmds.join(', ')}`
      });
      return;
    }

    const url = `http://localhost:${route.port}${route.endpoint}`;

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
      .then((r) => {
        if (!r.ok) throw new Error('Server returned ' + r.status);
        return r.text();
      })
      .then((data) => {
        if (action === 'READ') {
          data = formatReadResult(data);
        }
        sendResponse({ result: data });
      })
      .catch((err) => {
        const toolName = getToolName(route.port);
        sendResponse({
          error: `${toolName} server unreachable on port ${route.port} — is it running? (${err.message})`
        });
      });
  });

  return true;
});

function getToolName(port) {
  if (port === 2407) return 'Lifecycle';
  if (manifestCache) {
    for (const [name, tool] of Object.entries(manifestCache)) {
      if (tool.port === port) return tool.ui?.label || name;
    }
  }
  return `Port ${port}`;
}

// ─── YouTube Tab Watcher ──────────────────────────────────────────────────────

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (
      (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com' ||
       u.hostname === 'music.youtube.com') &&
      u.pathname === '/watch'
    ) {
      return u.searchParams.get('v') || null;
    }
  } catch (_) {}
  return null;
}

async function getLastVideoId() {
  const result = await chrome.storage.session.get('lastVideoId');
  return result.lastVideoId || null;
}

async function setLastVideoId(id) {
  await chrome.storage.session.set({ lastVideoId: id });
}

async function fetchOEmbed(videoId) {
  const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return { title: data.title, author: data.author_name };
  } catch (_) {
    return null;
  }
}

async function notifyBracketTabs(videoInfo) {
  const targets = [
    'https://claude.ai/*',
    'https://chatgpt.com/c/*',
    'https://chat.deepseek.com/*',
    'https://*.deepseek.com/*',
    'https://gemini.google.com/app/*',
  ];
  for (const pattern of targets) {
    const tabs = await chrome.tabs.query({ url: pattern }).catch(() => []);
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'YOUTUBE_CONTEXT',
        ...videoInfo,
      }).catch(() => {});
    }
  }
}

async function notifyBracketTabsCleared() {
  const targets = [
    'https://claude.ai/*',
    'https://chatgpt.com/c/*',
    'https://chat.deepseek.com/*',
    'https://*.deepseek.com/*',
    'https://gemini.google.com/app/*',
  ];
  for (const pattern of targets) {
    const tabs = await chrome.tabs.query({ url: pattern }).catch(() => []);
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'YOUTUBE_CLEARED' }).catch(() => {});
    }
  }
}

async function checkTab(tab) {
  if (!tab || !tab.url) return;
  const videoId = extractVideoId(tab.url);
  if (!videoId) return;
  const lastVideoId = await getLastVideoId();
  if (videoId === lastVideoId) return;
  await setLastVideoId(videoId);
  const info = await fetchOEmbed(videoId);
  if (info) {
    await notifyBracketTabs({ videoId, ...info });
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) checkTab(tab);
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await chrome.tabs.get(activeInfo.tabId).catch(() => null);
  if (tab) checkTab(tab);
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.session.remove('lastVideoId').catch(() => {});
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const tab of tabs) {
    const videoId = extractVideoId(tab.url || '');
    if (videoId) { await checkTab(tab); break; }
  }
});

chrome.tabs.onRemoved.addListener(async () => {
  const youtubeTabs = await chrome.tabs.query({
    url: ['https://www.youtube.com/watch*', 'https://music.youtube.com/watch*'],
  }).catch(() => []);
  if (youtubeTabs.length === 0) {
    await chrome.storage.session.remove('lastVideoId').catch(() => {});
    await notifyBracketTabsCleared();
  }
});

// ─── Steam Presence Watcher ───────────────────────────────────────────────────
// Steam key/ID are no longer hardcoded — set them from the popup's API Keys
// panel. They're stored in chrome.storage.local (this machine only, never
// synced, never committed to the repo).

const STEAM_POLL_MS = 30000;

async function getSteamCreds() {
  const data = await chrome.storage.local.get(['steamApiKey', 'steamId']);
  return { apiKey: data.steamApiKey || null, steamId: data.steamId || null };
}

async function getLastGame() {
  const data = await chrome.storage.session.get('lastSteamGame');
  return data.lastSteamGame || null;
}

async function setLastGame(game) {
  await chrome.storage.session.set({ lastSteamGame: game || null });
}

async function pollSteam() {
  try {
    const { apiKey, steamId } = await getSteamCreds();
    if (!apiKey || !steamId) {
      console.log('[Bracket/Steam] Skipping poll — key or ID not set.');
      return;
    }

    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${apiKey}&steamids=${steamId}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[Bracket/Steam] API returned ${res.status} ${res.statusText}`);
      return;
    }
    const { response } = await res.json();
    const player = response?.players?.[0];
    if (!player) {
      console.warn('[Bracket/Steam] No player data returned — check steamId is your numeric SteamID64, and that your Steam profile/game-activity privacy is not set to Private.');
      return;
    }
    const currentGame = player?.gameextrainfo || null;
    console.log('[Bracket/Steam] Poll OK. Current game:', currentGame || '(none)');

    const lastGame = await getLastGame();
    if (currentGame === lastGame) return;

    await setLastGame(currentGame);

    const msg = currentGame
      ? { type: 'STEAM_CONTEXT', game: currentGame }
      : { type: 'STEAM_CLEARED' };

    const patterns = [
      'https://claude.ai/*',
      'https://chatgpt.com/c/*',
      'https://chat.deepseek.com/*',
      'https://*.deepseek.com/*',
      'https://gemini.google.com/app/*',
    ];

    for (const pattern of patterns) {
      const tabs = await chrome.tabs.query({ url: pattern }).catch(() => []);
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[Bracket/Steam] Poll failed:', err.message);
  }
}

// Start polling when service worker starts
pollSteam();
setInterval(pollSteam, STEAM_POLL_MS);

// On startup, clear stale state if no game is running
chrome.storage.session.get('lastSteamGame', (data) => {
  if (!data.lastSteamGame) {
    const msg = { type: 'STEAM_CLEARED' };
    ['https://claude.ai/*', 'https://chatgpt.com/c/*', 'https://chat.deepseek.com/*', 'https://*.deepseek.com/*', 'https://gemini.google.com/app/*']
      .forEach(pattern => {
        chrome.tabs.query({ url: pattern }).then(tabs => {
          tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, msg).catch(() => {}));
        }).catch(() => {});
      });
  }
});
