'use strict';

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    id: 'lifecycle',
    label: 'Lifecycle',
    icon: '⚙',
    port: 2407,
    groups: [
      {
        label: 'Discovery',
        cmds: [
          { cmd: '[(SYSTEM)]',                          desc: 'orientation + entry point' },
          { cmd: '[(SERVER_LIST)]',                     desc: 'running tool status' },
          { cmd: '[(README {"name":"memory"})]',        desc: 'read a tool\'s instructions' },
        ],
      },
      {
        label: 'Control',
        cmds: [
          { cmd: '[(SERVER_START {"name":"memory"})]',  desc: 'start a tool server' },
          { cmd: '[(SERVER_STOP {"name":"chess"})]',    desc: 'stop a tool server' },
        ],
      },
    ],
  },
  {
    id: 'memory',
    label: 'Memory',
    icon: '⬡',
    port: 2408,
    groups: [
      {
        label: 'Read',
        cmds: [
          { cmd: '[(TAGINDEX)]',                                           desc: 'all tags + counts' },
          { cmd: '[(SEARCH {"tags":"tag1","limit":10})]',                  desc: 'find memories' },
          { cmd: '[(LIST {"limit":20})]',                                  desc: 'recent memories' },
          { cmd: '[(READ {"id":"filename_c91"})]',                         desc: 'read + required' },
        ],
      },
      {
        label: 'Write',
        cmds: [
          { cmd: '[(STORE {"tags":"…","recipe":"…","confidence":0.9,"importance":"high","model":"claude"})]', desc: 'save memory' },
          { cmd: '[(UPDATE {"id":"…","tags":"…","recipe":"…"})]',          desc: 'update fields' },
        ],
      },
    ],
  },
  {
    id: 'chess',
    label: 'Chess',
    icon: '♟',
    port: 2409,
    groups: [
      {
        label: 'Board',
        cmds: [
          { cmd: '[(BOARD)]',               desc: 'board + FEN + turn' },
          { cmd: '[(MOVES)]',               desc: 'all legal moves' },
          { cmd: '[(LIST)]',                desc: 'move history' },
          { cmd: '[(RESETBOARD)]',          desc: 'reset to start' },
        ],
      },
      {
        label: 'Play',
        cmds: [
          { cmd: '[(MOVE {"san":"e4"})]',   desc: 'play a move (SAN or UCI)' },
          { cmd: '[(RECOMMENDATION)]',      desc: 'Stockfish eval (async)' },
          { cmd: '[(DEPTH {"level":15})]',  desc: 'set search depth (1–30)' },
        ],
      },
    ],
  },
  {
    id: 'moltbook',
    label: 'Moltbook',
    icon: '🦞',
    port: 2411,
    groups: [
      {
        label: 'Feed',
        cmds: [
          { cmd: '[(MOLT_HOME)]',                                                 desc: 'notifications + following feed' },
          { cmd: '[(MOLT_FEED {"sort":"hot","limit":10})]',                       desc: 'browse main feed' },
          { cmd: '[(MOLT_READ {"post_id":"…"})]',                                 desc: 'read post + comments' },
          { cmd: '[(MOLT_SEARCH {"q":"AI agents"})]',                             desc: 'semantic search' },
        ],
      },
      {
        label: 'Post',
        cmds: [
          { cmd: '[(MOLT_POST {"submolt":"general","title":"…","content":"…"})]', desc: 'create a post' },
          { cmd: '[(MOLT_COMMENT {"post_id":"…","content":"…"})]',                desc: 'comment on a post' },
          { cmd: '[(MOLT_UPVOTE {"post_id":"…"})]',                               desc: 'upvote a post' },
          { cmd: '[(MOLT_DOWNVOTE {"post_id":"…"})]',                             desc: 'downvote a post' },
        ],
      },
      {
        label: 'Account',
        cmds: [
          { cmd: '[(MOLT_AGENTS)]',                                               desc: 'list loaded agent aliases' },
          { cmd: '[(MOLT_ME {"as":"claude"})]',                                   desc: 'your agent profile' },
          { cmd: '[(MOLT_REGISTER {"name":"…","description":"…"})]',              desc: 'register a new agent' },
          { cmd: '[(MOLT_SUBMOLTS)]',                                             desc: 'list all submolts' },
          { cmd: '[(MOLT_FOLLOW {"molty":"…"})]',                                 desc: 'follow an agent' },
          { cmd: '[(MOLT_KEYS_SET {"alias":"claude","key":"moltbook_sk_…"})]',     desc: 'save an agent key' },
          { cmd: '[(MOLT_KEYS_DELETE {"alias":"…"})]',                             desc: 'remove an agent key' },
        ],
      },
    ],
  },
];

// ─── State ────────────────────────────────────────────────────────────────────

const serverStatus = {};  // id → true/false
let currentTool = null;

// ─── Pings ────────────────────────────────────────────────────────────────────

async function ping(port) {
  try {
    const r = await fetch(`http://localhost:${port}/ping`, {
      signal: AbortSignal.timeout(1200),
    });
    return r.ok;
  } catch (_) { return false; }
}

async function checkAll() {
  for (const tool of TOOLS) {
    const ok = await ping(tool.port);
    serverStatus[tool.id] = ok;
    applyStatus(tool.id, ok);
  }
  if (currentTool) updateDetailStatus();
}

function applyStatus(id, ok) {
  const dot = document.getElementById('dot-' + id);
  if (dot) { dot.classList.toggle('online', ok); dot.classList.toggle('offline', !ok); }
}

// ─── Stop a single server ─────────────────────────────────────────────────────

async function stopServer(name) {
  try {
    await fetch('http://localhost:2407/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (_) {}
  await checkAll();
}

async function stopAll() {
  try {
    await fetch('http://localhost:2407/stopall', {
      method: 'POST',
      body: '{}',
      signal: AbortSignal.timeout(3000),
    });
  } catch (_) {}
  await checkAll();
}

// ─── Confirm/Deny pattern ────────────────────────────────────────────────────

function armConfirm({ triggerEl, confirmEl, denyEl, onConfirm }) {
  triggerEl.addEventListener('click', (e) => {
    e.stopPropagation();
    triggerEl.style.display = 'none';
    confirmEl.style.display = '';
    denyEl.style.display = '';
  });
  confirmEl.addEventListener('click', async (e) => {
    e.stopPropagation();
    confirmEl.style.display = 'none';
    denyEl.style.display = 'none';
    triggerEl.style.display = '';
    await onConfirm();
  });
  denyEl.addEventListener('click', (e) => {
    e.stopPropagation();
    confirmEl.style.display = 'none';
    denyEl.style.display = 'none';
    triggerEl.style.display = '';
  });
}

// ─── Kill All (header) ───────────────────────────────────────────────────────

armConfirm({
  triggerEl: document.getElementById('kill-all-btn'),
  confirmEl: document.getElementById('kill-confirm'),
  denyEl:    document.getElementById('kill-deny'),
  onConfirm: stopAll,
});

// ─── List View ────────────────────────────────────────────────────────────────

const listView  = document.getElementById('list-view');
const noResults = document.getElementById('no-results');
const searchEl  = document.getElementById('search');

function buildList() {
  listView.querySelectorAll('.tool-row').forEach(r => r.remove());

  for (const tool of TOOLS) {
    const cmdCount = tool.groups.reduce((n, g) => n + g.cmds.length, 0);

    const row = document.createElement('div');
    row.className = 'tool-row';
    row.dataset.toolId = tool.id;

    // Clickable main area → detail
    const main = document.createElement('div');
    main.className = 'tool-main';
    main.innerHTML = `
      <div class="dot" id="dot-${tool.id}"></div>
      <span class="tool-icon">${tool.icon}</span>
      <span class="tool-label">${tool.label}</span>
      <span class="tool-count">${cmdCount} cmds</span>
      <span class="tool-arrow">›</span>
    `;
    main.addEventListener('click', () => openDetail(tool));

    // Stop cluster
    const cluster = document.createElement('div');
    cluster.className = 'stop-cluster';

    const stopBtn     = document.createElement('button');
    const stopConfirm = document.createElement('button');
    const stopDeny    = document.createElement('button');

    stopBtn.className     = 'stop-btn';     stopBtn.textContent     = '■ stop';
    stopConfirm.className = 'stop-confirm'; stopConfirm.textContent = '✓';
    stopDeny.className    = 'stop-deny';    stopDeny.textContent    = '✕';

    armConfirm({
      triggerEl: stopBtn,
      confirmEl: stopConfirm,
      denyEl:    stopDeny,
      onConfirm: () => stopServer(tool.id),
    });

    cluster.appendChild(stopBtn);
    cluster.appendChild(stopConfirm);
    cluster.appendChild(stopDeny);

    row.appendChild(main);
    row.appendChild(cluster);
    listView.appendChild(row);
  }

  listView.appendChild(noResults);
  filterList('');
}

function filterList(query) {
  const q = query.toLowerCase().trim();
  let visible = 0;
  listView.querySelectorAll('.tool-row').forEach(row => {
    const id = row.dataset.toolId;
    if (!id) return;
    const tool = TOOLS.find(t => t.id === id);
    const match = !q ||
      tool.label.toLowerCase().includes(q) ||
      tool.id.toLowerCase().includes(q) ||
      tool.groups.some(g =>
        g.cmds.some(c => c.cmd.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q))
      );
    row.classList.toggle('hidden', !match);
    if (match) visible++;
  });
  noResults.style.display = visible === 0 ? 'block' : 'none';
}

// ─── Detail View ──────────────────────────────────────────────────────────────

const detailView = document.getElementById('detail-view');

function openDetail(tool) {
  currentTool = tool;
  listView.classList.remove('active');
  detailView.classList.add('active');
  searchEl.value = '';

  document.getElementById('detail-title').textContent = `${tool.icon} ${tool.label}`;
  updateDetailStatus();

  const body = document.getElementById('detail-body');
  body.innerHTML = '';

  for (const group of tool.groups) {
    const wrap = document.createElement('div');
    wrap.className = 'cmd-group';

    const label = document.createElement('div');
    label.className = 'cmd-group-label';
    label.textContent = group.label;
    wrap.appendChild(label);

    for (const c of group.cmds) {
      const item = document.createElement('div');
      item.className = 'cmd-item';
      item.innerHTML = `<span>${esc(c.cmd)}</span><span class="cmd-desc">— ${esc(c.desc)}</span>`;
      wrap.appendChild(item);
    }

    body.appendChild(wrap);
  }

  // Copy README button (lifecycle has no README)
  if (tool.id !== 'lifecycle') {
    const copyBtn = document.createElement('button');
    copyBtn.id = 'copy-readme';
    copyBtn.textContent = 'Copy system instructions';
    copyBtn.addEventListener('click', () => copyReadme(tool, copyBtn));
    body.appendChild(copyBtn);
  }
}

function updateDetailStatus() {
  if (!currentTool) return;
  const ok = serverStatus[currentTool.id];
  const el = document.getElementById('detail-online');
  if (ok === undefined) { el.textContent = ''; return; }
  el.textContent = ok ? '● online' : '○ offline';
  el.style.color = ok ? '#86efac' : '#4b5563';
}

async function copyReadme(tool, btn) {
  try {
    const r = await fetch('http://localhost:2407/readme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: tool.id }),
      signal: AbortSignal.timeout(3000),
    });
    const text = await r.text();
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied ✓';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy system instructions';
      btn.classList.remove('copied');
    }, 2000);
  } catch (err) {
    btn.textContent = 'Failed — is lifecycle running?';
    setTimeout(() => { btn.textContent = 'Copy system instructions'; }, 2500);
  }
}

function closeDetail() {
  currentTool = null;
  detailView.classList.remove('active');
  listView.classList.add('active');
}

document.getElementById('detail-header').addEventListener('click', closeDetail);

// ─── Search ───────────────────────────────────────────────────────────────────

searchEl.addEventListener('input', () => {
  if (detailView.classList.contains('active')) closeDetail();
  filterList(searchEl.value);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

buildList();
checkAll();

// ─── Ambient Toggles ──────────────────────────────────────────────────────────

(function () {
  const toggleTimestamp    = document.getElementById('toggle-timestamp');
  const toggleYoutube      = document.getElementById('toggle-youtube');
  const toggleConsolidation = document.getElementById('toggle-consolidation');
  const thresholdInput     = document.getElementById('threshold-input');
  const thresholdRow       = document.getElementById('threshold-row');

  // Load saved values
  chrome.storage.sync.get({
    timestampEnabled: true,
    youtubeEnabled: true,
    consolidationEnabled: true,
    consolidationThreshold: 20,
  }, (data) => {
    toggleTimestamp.checked     = data.timestampEnabled;
    toggleYoutube.checked       = data.youtubeEnabled;
    toggleConsolidation.checked = data.consolidationEnabled;
    thresholdInput.value        = data.consolidationThreshold;
    thresholdRow.style.display  = data.consolidationEnabled ? '' : 'none';
  });

  toggleTimestamp.addEventListener('change', () => {
    chrome.storage.sync.set({ timestampEnabled: toggleTimestamp.checked });
  });

  toggleYoutube.addEventListener('change', () => {
    chrome.storage.sync.set({ youtubeEnabled: toggleYoutube.checked });
  });

  toggleConsolidation.addEventListener('change', () => {
    chrome.storage.sync.set({ consolidationEnabled: toggleConsolidation.checked });
    thresholdRow.style.display = toggleConsolidation.checked ? '' : 'none';
  });

  thresholdInput.addEventListener('change', () => {
    const val = Math.max(5, Math.min(100, parseInt(thresholdInput.value) || 20));
    thresholdInput.value = val;
    chrome.storage.sync.set({ consolidationThreshold: val });
  });
})();
