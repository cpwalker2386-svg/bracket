'use strict';

// ─── Tool Registry ────────────────────────────────────────────────────────────

const TOOL_ROUTES = {
  // ── Memory (port 2408) ──
  STORE:     { port: 2408, endpoint: '/store' },
  RECONSTRUCT: { port: 2408, endpoint: '/reconstruct' },
  SEARCH:    { port: 2408, endpoint: '/search' },
  LIST:      { port: 2408, endpoint: '/list' },
  READ:      { port: 2408, endpoint: '/read-with-requires' },
  UPDATE:    { port: 2408, endpoint: '/update' },
  TAGINDEX:  { port: 2408, endpoint: '/tag-index' },
  TAG_INDEX: { port: 2408, endpoint: '/tag-index' },

  // ── Browse (port 2410) ──
  BROWSE:  { port: 2410, endpoint: '/browse' },
  OPENURL: { port: 2410, endpoint: '/openurl' },

  // ── Chess (port 2409) ──
  BOARD:          { port: 2409, endpoint: '/board' },
  MOVES:          { port: 2409, endpoint: '/moves' },
  MOVE:           { port: 2409, endpoint: '/move' },
  MOVE_HISTORY: { port: 2409, endpoint: '/list' },
  RECOMMENDATION: { port: 2409, endpoint: '/recommendation' },
  DEPTH:          { port: 2409, endpoint: '/depth' },
  UNDO:           { port: 2409, endpoint: '/undo' },
  RESETBOARD:     { port: 2409, endpoint: '/reset' },

  // ── Lifecycle (port 2407) ──
  SYSTEM:       { port: 2407, endpoint: '/system' },
  README:       { port: 2407, endpoint: '/readme' },
  SERVER_START: { port: 2407, endpoint: '/start' },
  SERVER_STOP:  { port: 2407, endpoint: '/stop' },
  SERVER_LIST:  { port: 2407, endpoint: '/list' },

  // ── Moltbook (port 2411) ──
  MOLT_REGISTER:  { port: 2411, endpoint: '/molt_register' },
  MOLT_HOME:      { port: 2411, endpoint: '/molt_home' },
  MOLT_STATUS:    { port: 2411, endpoint: '/molt_status' },
  MOLT_ME:        { port: 2411, endpoint: '/molt_me' },
  MOLT_FEED:      { port: 2411, endpoint: '/molt_feed' },
  MOLT_POST:      { port: 2411, endpoint: '/molt_post' },
  MOLT_COMMENT:   { port: 2411, endpoint: '/molt_comment' },
  MOLT_READ:      { port: 2411, endpoint: '/molt_read' },
  MOLT_UPVOTE:    { port: 2411, endpoint: '/molt_upvote' },
  MOLT_DOWNVOTE:  { port: 2411, endpoint: '/molt_downvote' },
  MOLT_SEARCH:    { port: 2411, endpoint: '/molt_search' },
  MOLT_SUBMOLTS:  { port: 2411, endpoint: '/molt_submolts' },
  MOLT_SUBSCRIBE: { port: 2411, endpoint: '/molt_subscribe' },
  MOLT_FOLLOW:    { port: 2411, endpoint: '/molt_follow' },
  MOLT_PROFILE:   { port: 2411, endpoint: '/molt_profile' },
  MOLT_VERIFY:    { port: 2411, endpoint: '/molt_verify' },
  MOLT_DELETE:    { port: 2411, endpoint: '/molt_delete' },
  MOLT_AGENTS:      { port: 2411, endpoint: '/molt_agents' },
  MOLT_KEYS_SET:    { port: 2411, endpoint: '/molt_keys_set' },
  MOLT_KEYS_DELETE: { port: 2411, endpoint: '/molt_keys_delete' },
  MOLT_NOTIFICATIONS_READ: { port: 2411, endpoint: '/molt_notifications_read' },

  // ── Oracle (port 2412) ──
  ORACLE_PING: { port: 2412, endpoint: '/ping' },
  ASK:         { port: 2412, endpoint: '/ask' },
  SANITY:      { port: 2412, endpoint: '/sanity' },
  SEE:         { port: 2412, endpoint: '/see' },
  THINK:       { port: 2412, endpoint: '/think' },
};

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

  if (!msg.command) return;

  const parsed = parseCommand(msg.command);

  if (!parsed) {
    sendResponse({ error: 'Could not parse command: ' + msg.command });
    return true;
  }

  if (parsed.error) {
    sendResponse({ error: parsed.error });
    return true;
  }

  const { action, params } = parsed;
  const route = TOOL_ROUTES[action];

  if (!route) {
    const validCmds = [...new Set(Object.keys(TOOL_ROUTES).filter(k => !k.includes('_') || k === 'TAG_INDEX'))];
    sendResponse({
      error: `Unknown command: ${action}. Valid commands: ${validCmds.join(', ')}`
    });
    return true;
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

  return true;
});

function getToolName(port) {
  const names = { 2407: 'Lifecycle', 2408: 'Memory', 2409: 'Chess', 2410: 'Browse', 2411: 'Moltbook', 2412: 'Oracle' };
  return names[port] || `Port ${port}`;
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

const STEAM_API_KEY = '955936D332B0F146BE9DAA3C50077687';
const STEAM_ID      = '76561198316524687';
const STEAM_POLL_MS = 30000;

async function getLastGame() {
  const data = await chrome.storage.session.get('lastSteamGame');
  return data.lastSteamGame || null;
}

async function setLastGame(game) {
  await chrome.storage.session.set({ lastSteamGame: game || null });
}

async function pollSteam() {
  try {
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${STEAM_ID}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const { response } = await res.json();
    const player = response?.players?.[0];
    const currentGame = player?.gameextrainfo || null;

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
  } catch (_) {}
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