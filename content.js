(function () {
  'use strict';

  // ─── Site Config ─────────────────────────────────────────────────────────────

  const SITES = {
    claude: {
      hostname: 'claude.ai',
      messageSelectors: [
        '[data-is-streaming="false"] .font-claude-response',
        '[data-is-streaming="false"] [class*="prose"]',
        '[data-is-streaming="false"] [class*="response"]',
      ],
      getEditor: () =>
        document.querySelector("div[contenteditable='true'].ProseMirror") ||
        document.querySelector("div[contenteditable='true'][data-testid='chat-input']") ||
        document.querySelector("div[contenteditable='true']"),
      isTextarea: false,
      textareaTest: (el) =>
        el.tagName === 'TEXTAREA' || el.getAttribute('contenteditable') === 'true',
    },
    chatgpt: {
      hostname: 'chatgpt.com',
      messageSelectors: [
        '[data-message-author-role="assistant"] .markdown',
        '[data-message-author-role="assistant"] [class*="prose"]',
        '.agent-turn [class*="markdown"]',
      ],
      getEditor: () =>
        document.querySelector('div[contenteditable="true"][data-testid="chat-input"]') ||
        document.querySelector('#prompt-textarea') ||
        document.querySelector('div[contenteditable="true"]'),
      isTextarea: false,
      textareaTest: (el) =>
        el.tagName === 'TEXTAREA' ||
        el.getAttribute('contenteditable') === 'true' ||
        el.getAttribute('role') === 'textbox',
    },
    deepseek: {
      hostname: 'deepseek.com',
      messageSelectors: [
        '.ds-markdown.ds-markdown--block',
        '.ds-assistant-message-main-content',
      ],
      getEditor: () =>
        document.querySelector('textarea[placeholder="Message DeepSeek"]') ||
        document.querySelector('textarea[name="search"]'),
      isTextarea: true,
      textareaTest: (el) =>
        el.tagName === 'TEXTAREA' || el.getAttribute('contenteditable') === 'true',
    },
    gemini: {
      hostname: 'gemini.google.com',
      messageSelectors: [
        '.markdown.markdown-main-panel.tutor-markdown-rendering',
        'message-content .markdown',
        '[id^="model-response-message-content"] .markdown',
        '.markdown.markdown-main-panel',
      ],
      getEditor: () =>
        document.querySelector('div[contenteditable="true"][role="textbox"]') ||
        document.querySelector('rich-textarea div[contenteditable="true"]'),
      isTextarea: false,
      textareaTest: (el) =>
        el.tagName === 'TEXTAREA' ||
        el.getAttribute('contenteditable') === 'true' ||
        el.getAttribute('role') === 'textbox',
    },
  };

  function detectSite() {
    const host = location.hostname;
    for (const [name, cfg] of Object.entries(SITES)) {
      if (host.includes(cfg.hostname)) return { name, ...cfg };
    }
    return null;
  }

  const site = detectSite();
  if (!site) return;

  const msgSelectorStr = site.messageSelectors.join(', ');

  // ─── Ambient Feature State ────────────────────────────────────────────────────

  let timestampEnabled    = true;
  let youtubeEnabled      = true;
  let consolidationEnabled = true;
  let consolidationThreshold = 20;
  let pendingYouTubeContext = null;

  // Steam state – only inject on change
  let lastInjectedGame = null;
  let steamPending = null; // set by either background broadcast or preemptive poll

  // Message counter – per-model, resets on STORE
  let messageCount = 0;
  let consolidationFired = false;

  // Load initial prefs from sync storage
  chrome.storage.sync.get({
    timestampEnabled: true,
    youtubeEnabled: true,
    consolidationEnabled: true,
    consolidationThreshold: 20,
  }, (data) => {
    timestampEnabled        = data.timestampEnabled;
    youtubeEnabled          = data.youtubeEnabled;
    consolidationEnabled    = data.consolidationEnabled;
    consolidationThreshold  = data.consolidationThreshold;
  });

  // Keep in sync with popup changes
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.timestampEnabled      !== undefined) timestampEnabled      = changes.timestampEnabled.newValue;
    if (changes.youtubeEnabled        !== undefined) youtubeEnabled        = changes.youtubeEnabled.newValue;
    if (changes.consolidationEnabled  !== undefined) consolidationEnabled  = changes.consolidationEnabled.newValue;
    if (changes.consolidationThreshold !== undefined) consolidationThreshold = changes.consolidationThreshold.newValue;
  });

  // ─── Listen for background broadcasts (YouTube + Steam) ──────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'YOUTUBE_CONTEXT') {
      pendingYouTubeContext = `[Listening: "${message.title}" by ${message.author}]`;
    }
    if (message.type === 'YOUTUBE_CLEARED') {
      pendingYouTubeContext = '[Listening: nothing]';
    }
    if (message.type === 'STEAM_CONTEXT') {
      const newGame = message.game || null;
      // Only set pending if it differs from what was last injected
      if (newGame !== lastInjectedGame) {
        steamPending = newGame ? `[Playing: ${newGame}]` : '[Playing: nothing]';
      }
    }
    if (message.type === 'STEAM_CLEARED') {
      // Only set pending if a game was previously shown
      if (lastInjectedGame !== null) {
        steamPending = '[Playing: nothing]';
      }
    }
  });

  // ─── Steam Preemptive Polling (state-change aware) ──────────────────────────

  document.addEventListener('keydown', function (e) {
    const editor = site.getEditor();
    if (!editor) return;
    if (document.activeElement !== editor && !editor.contains(document.activeElement)) return;

    chrome.runtime.sendMessage({ type: 'POLL_STEAM' }, (response) => {
      const newGame = response?.game || null;
      // Only update if it differs from last injected state
      if (newGame !== lastInjectedGame) {
        steamPending = newGame ? `[Playing: ${newGame}]` : '[Playing: nothing]';
      }
    });
  }, true);

  // ─── Timestamp Helpers ────────────────────────────────────────────────────────

  function getTimestamp() {
    const now = new Date();
    const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const day    = days[now.getDay()];
    const month  = months[now.getMonth()];
    const date   = now.getDate();
    const year   = now.getFullYear();
    let hours    = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const ampm   = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `[Sent: ${day}, ${month} ${date} ${year} - ${hours}:${minutes}:${seconds} ${ampm}]`;
  }

  function appendText(editor, text) {
    if (editor.tagName === 'TEXTAREA') {
      const current = editor.value.trimEnd();
      editor.value = current + '\n' + text;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('insertText', false, '\n' + text);
    }
  }

  function alreadyStamped(editor) {
    const text = editor.tagName === 'TEXTAREA'
      ? editor.value
      : editor.innerText || '';
    const lines = text.trim().split('\n');
    return lines[lines.length - 1].trim().startsWith('[Sent:');
  }

  function getSendButton(editor) {
    const byLabel = document.querySelector('button[aria-label="Send message"]');
    if (byLabel) return byLabel;
    if (editor && editor.tagName === 'TEXTAREA') {
      const container = editor.closest('form') || editor.closest('div[class*="chat"]') || editor.parentElement;
      if (container) return container.querySelector('div[role="button"]');
    }
    return null;
  }

  // ─── Enter intercept: ambient tags ────────────────────────────────────────────

  let sending = false;

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.shiftKey) return;

    const editor = site.getEditor();
    if (!editor) return;
    if (document.activeElement !== editor && !editor.contains(document.activeElement)) return;

    // If pending tool results exist, let the Bracket result-injection handler deal with it
    if (typeof pendingResults !== 'undefined' && pendingResults.length > 0) return;

    const text = editor.tagName === 'TEXTAREA'
      ? editor.value.trim()
      : (editor.innerText || '').trim();

    if (!text) return;
    if (alreadyStamped(editor)) return;
    if (sending) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    // 1. Consolidation prompt
    if (consolidationEnabled && !consolidationFired) {
      messageCount++;
      if (messageCount >= consolidationThreshold) {
        appendText(editor, '[Memory: Anything worth keeping?]');
        consolidationFired = true;
        messageCount = 0;
      }
    } else if (!consolidationFired) {
      messageCount++;
    }

    // 2. YouTube context
    if (youtubeEnabled && pendingYouTubeContext) {
      appendText(editor, pendingYouTubeContext);
      pendingYouTubeContext = null;
    }

    // 3. Steam context – only inject on change, and update lastInjectedGame
    if (steamPending) {
      appendText(editor, steamPending);
      const match = steamPending.match(/\[Playing: (.*?)\]/);
      lastInjectedGame = (match && match[1] !== 'nothing') ? match[1] : null;
      steamPending = null;
    }

    // 4. Timestamp – always present, always last
    if (timestampEnabled) {
      appendText(editor, getTimestamp());
    }

    sending = true;

    setTimeout(() => {
      const sendBtn = getSendButton(editor);
      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
      } else {
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true,
        }));
      }
      setTimeout(() => { sending = false; }, 5000);
    }, 150);

  }, true);

  // ─── Tool Registry (dynamic) ──────────────────────────────────────────────────
  // Loaded from each server's manifest.json via the lifecycle server, relayed
  // through background.js. No tool is hardcoded here — dropping a new
  // servers/<name>/manifest.json is enough for it to show up automatically.

  let TOOLS = {};
  let ACTION_TO_TOOL = {};
  let ALL_COMMANDS = new Set();
  let toolsReady = false;

  // A small number of tools need page-context logic beyond what a JSON
  // manifest can express (e.g. a pre-flight fetch check). Keep those here,
  // keyed by tool name, and manifest.json stays pure data for everything else.
  const PRE_EXECUTE_HOOKS = {
    memory: async (action, params) => {
      if (action !== 'STORE') return null;
      try {
        const r = await fetch('http://localhost:2408/exists', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(params) });
        const exists = await r.text();
        if (exists.trim() === 'true') return 'SKIPPED: Memory already exists on disk.';
      } catch (_) {}
      return null;
    },
  };

  // Lifecycle's own commands aren't in any servers/*/manifest.json — it's the
  // loader itself, so (like background.js's LIFECYCLE_ROUTES) it gets one
  // small static entry here instead of being dynamically discovered.
  const LIFECYCLE_TOOL = {
    commands: new Set(['SYSTEM', 'README', 'SERVER_START', 'SERVER_STOP', 'SERVER_LIST']),
    label: 'LIFECYCLE',
    icon: '⚙',
    colors: { border: '#6b7280', bg: '#111827', text: '#d1d5db', header: '#9ca3af', btnBg: '#1f2937', btnBorder: '#6b7280', btnText: '#d1d5db', resultColor: '#d1d5db' },
    asyncCommands: new Set(),
    asyncLoadingText: null,
    asyncReadyText: null,
    preExecute: null,
  };

  function loadTools() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_MANIFESTS' }, (response) => {
        if (chrome.runtime.lastError || !response || !response.manifests) {
          console.warn('[Bracket] Failed to load tool manifests — is the lifecycle manager running?');
          resolve(false);
          return;
        }
        TOOLS = { lifecycle: LIFECYCLE_TOOL };
        for (const [name, tool] of Object.entries(response.manifests)) {
          TOOLS[name] = {
            commands: new Set(Object.keys(tool.routes)),
            label: tool.ui.label,
            icon: tool.ui.icon,
            colors: tool.ui.colors,
            asyncCommands: new Set(tool.ui.asyncCommands || []),
            asyncLoadingText: tool.ui.asyncLoadingText,
            asyncReadyText: tool.ui.asyncReadyText,
            preExecute: PRE_EXECUTE_HOOKS[name] || null,
          };
        }
        ACTION_TO_TOOL = {};
        for (const [, tool] of Object.entries(TOOLS)) {
          for (const cmd of tool.commands) ACTION_TO_TOOL[cmd] = tool;
        }
        ALL_COMMANDS = new Set(Object.keys(ACTION_TO_TOOL));
        toolsReady = true;
        resolve(true);
      });
    });
  }

  let pendingResults = [];
  const processingNow = new WeakSet();

  function extractCommands(text) {
    const results = [];
    let i = 0;
    while (i < text.length) {
      if (text[i] === '[' && text[i + 1] === '(') {
        let depth = 1;
        let j = i + 2;
        while (j < text.length && depth > 0) {
          if (text[j] === '"') {
            j++;
            while (j < text.length) {
              if (text[j] === '\\') { j += 2; continue; }
              if (text[j] === '"') { j++; break; }
              j++;
            }
            continue;
          }
          if (text[j] === '[' && text[j + 1] === '(') { depth++; j += 2; continue; }
          if (text[j] === ')' && text[j + 1] === ']') { depth--; if (depth > 0) { j += 2; continue; } else { break; } }
          j++;
        }
        if (depth === 0) {
          const inner = text.slice(i + 2, j).trim();
          const match = inner.match(/^([\w]+)\s*(\{[\s\S]*\})?$/);
          if (match) results.push({ full: text.slice(i, j + 2), action: match[1], json: match[2] || '{}' });
          i = j + 2;
          continue;
        }
      }
      i++;
    }
    return results;
  }

  function processMessageNode(el) {
    if (el.closest('[data-bracket-result]')) return;
    if (processingNow.has(el)) return;
    if (el.dataset.bracketPending) return;
    const text = (el.textContent || '').replace(/\s+/g, ' ');
    const allMatches = extractCommands(text);
    if (!allMatches.length) return;
    el.dataset.bracketPending = '1';
    processingNow.add(el);
    for (const match of allMatches) {
      const action = match.action.trim().toUpperCase();
      if (!ALL_COMMANDS.has(action)) continue;
      if (action === 'STORE') { messageCount = 0; consolidationFired = false; }
      renderCommandCard(action, match.json.trim(), el);
    }
    processingNow.delete(el);
  }

  function sanitizeJSON(raw) {
    try { return JSON.parse(raw); } catch (_) {}
    const out = {};
    const stringField = /"(\w+)"\s*:\s*"([\s\S]*?)(?<!\\)"(?=\s*[,}])/g;
    let m;
    while ((m = stringField.exec(raw)) !== null) out[m[1]] = m[2].replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    const numField = /"(\w+)"\s*:\s*(-?\d+\.?\d*)/g;
    while ((m = numField.exec(raw)) !== null) { if (!(m[1] in out)) out[m[1]] = parseFloat(m[2]); }
    const arrField = /"(\w+)"\s*:\s*\[([^\]]*)\]/g;
    while ((m = arrField.exec(raw)) !== null) {
      if (!(m[1] in out)) out[m[1]] = m[2].split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    }
    if (Object.keys(out).length === 0) throw new Error('Could not extract any fields from JSON');
    return out;
  }

  function renderCommandCard(action, json, parentEl) {
    const tool = ACTION_TO_TOOL[action];
    const c = tool.colors;
    let params = {}, parseError = null;
    try { params = sanitizeJSON(json); } catch (e) { parseError = e.message; }
    const card = document.createElement('div');
    card.dataset.bracketResult = 'true';
    card.style.cssText = `background:${c.bg};color:${c.text};padding:10px 14px;margin:8px 0;font-family:monospace;font-size:11px;border-left:3px solid ${c.border};white-space:pre-wrap;word-break:break-all;border-radius:0 4px 4px 0;`;
    const header = document.createElement('div');
    header.style.cssText = `color:${c.header};font-weight:bold;margin-bottom:6px;`;
    header.textContent = `${tool.icon} ${tool.label}: ${action}`;
    card.appendChild(header);
    const preview = document.createElement('div');
    preview.style.cssText = 'color:#9ca3af;margin-bottom:8px;white-space:pre-wrap;';
    if (parseError) { preview.textContent = 'Parse error: ' + parseError; preview.style.color = '#f87171'; }
    else { preview.textContent = Object.keys(params).length ? JSON.stringify(params, null, 2) : '(no params)'; }
    card.appendChild(preview);
    const btn = document.createElement('button');
    btn.textContent = 'Approve';
    btn.disabled = !!parseError;
    btn.style.cssText = `background:${c.btnBg};color:${c.btnText};border:1px solid ${c.btnBorder};font-family:monospace;font-size:11px;padding:4px 12px;border-radius:4px;cursor:pointer;${parseError ? 'opacity:0.4;cursor:not-allowed;' : ''}`;
    btn.addEventListener('click', () => {
      btn.textContent = 'Approved ✓'; btn.disabled = true; btn.style.cursor = 'default';
      card.style.borderLeftColor = c.text; header.style.color = c.text; header.textContent = `✓ ${tool.label}: ${action}`;
      executeCommand(action, params, json, card, tool);
    });
    card.appendChild(btn);
    parentEl.appendChild(card);
  }

  async function executeCommand(action, params, rawJson, cardEl, tool) {
    const c = tool.colors;
    if (tool.preExecute) {
      const earlyResult = await tool.preExecute(action, params);
      if (earlyResult !== null) { pendingResults.push(earlyResult); renderResultInCard(earlyResult, cardEl, c.resultColor); return; }
    }
    const isAsync = tool.asyncCommands.has(action);
    if (isAsync) {
      renderResultInCard(tool.asyncLoadingText || '[Working…]', cardEl, '#facc15');
      chrome.runtime.sendMessage({ command: action + ' ' + JSON.stringify(params) }, (response) => {
        if (chrome.runtime.lastError || response?.error) { const msg = `[${tool.label} Error: ${response?.error || chrome.runtime.lastError?.message}]`; pendingResults.push(msg); renderResultInCard(msg, cardEl, '#f87171'); return; }
        pendingResults.push(response.result); renderResultInCard(tool.asyncReadyText || '[Done — press Enter]', cardEl, '#86efac');
      });
    } else {
      chrome.runtime.sendMessage({ command: action + ' ' + JSON.stringify(params) }, (response) => {
        if (chrome.runtime.lastError || response?.error) { const msg = `[${tool.label} Error: ${response?.error || chrome.runtime.lastError?.message}]`; pendingResults.push(msg); renderResultInCard(msg, cardEl, '#f87171'); return; }
        pendingResults.push(response.result); renderResultInCard(response.result, cardEl, c.resultColor);
      });
    }
  }

  function renderResultInCard(text, cardEl, color) {
    const result = document.createElement('div');
    result.style.cssText = `margin-top:8px;padding-top:8px;border-top:1px solid #374151;color:${color || '#86efac'};white-space:pre-wrap;`;
    result.textContent = text;
    cardEl.appendChild(result);
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (pendingResults.length === 0) return;
    const active = document.activeElement;
    if (!active) return;
    if (!site.textareaTest(active)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const block = '[Memory Results]\n' + pendingResults.join('\n---\n') + '\n[/Memory Results]\n\n';
    pendingResults = [];
    if (active.tagName === 'TEXTAREA') { active.value = block + active.value; active.dispatchEvent(new Event('input', { bubbles: true })); }
    else { active.textContent = block + active.textContent; active.dispatchEvent(new InputEvent('input', { bubbles: true })); const range = document.createRange(); const sel = window.getSelection(); range.setStart(active.firstChild || active, block.length); range.collapse(true); sel.removeAllRanges(); sel.addRange(range); }
    const prev = active.style.outline; active.style.outline = '2px solid #86efac';
    setTimeout(() => { active.style.outline = prev; }, 600);
  }, true);

  function tryStampMessage(el) {
    if (!el) return;
    if (el.dataset.bracketSeen) return;
    el.dataset.bracketSeen = '1';
    setTimeout(() => processMessageNode(el), 800);
  }

  function watchStreamingAttr(container) {
    if (container.dataset.bracketAttrWatched) return;
    container.dataset.bracketAttrWatched = '1';
    new MutationObserver((muts, obs) => {
      for (const m of muts) {
        if (m.attributeName === 'data-is-streaming' && container.getAttribute('data-is-streaming') === 'false') {
          const msgEl = container.querySelector(site.messageSelectors[0]) || container.querySelector('[class*="prose"]') || container.querySelector('[class*="response"]');
          if (msgEl) tryStampMessage(msgEl);
          obs.disconnect();
        }
      }
    }).observe(container, { attributes: true });
  }

  function stampAndProcess(node) {
    if (node.nodeType !== 1) return;
    if (site.name === 'claude') {
      const streamContainers = node.matches?.('[data-is-streaming]') ? [node] : [...(node.querySelectorAll?.('[data-is-streaming]') || [])];
      for (const c of streamContainers) watchStreamingAttr(c);
    }
    if (site.name === 'gemini') {
      const busyContainers = node.matches?.('[aria-busy]') ? [node] : [...(node.querySelectorAll?.('[aria-busy]') || [])];
      for (const container of busyContainers) {
        if (container.dataset.bracketAttrWatched) continue;
        container.dataset.bracketAttrWatched = '1';
        new MutationObserver((muts, obs) => {
          for (const m of muts) {
            if (m.attributeName === 'aria-busy' && container.getAttribute('aria-busy') === 'false') {
              const msgEl = container.querySelector(site.messageSelectors[0]) || container;
              if (msgEl) tryStampMessage(msgEl);
              obs.disconnect();
            }
          }
        }).observe(container, { attributes: true });
      }
    }
    if (node.matches) {
      for (const sel of site.messageSelectors) { if (node.matches(sel)) { tryStampMessage(node); return; } }
    }
    if (site.name === 'deepseek' && node.matches && node.matches('.ds-icon-button, ._4f3769f')) {
      let msgEl = node.closest('.ds-assistant-message-main-content');
      if (!msgEl) { const container = node.closest('[data-virtual-list-item-key], .ds-message'); if (container) msgEl = container.querySelector('.ds-assistant-message-main-content'); }
      if (msgEl) processMessageNode(msgEl);
      return;
    }
    if (site.name === 'chatgpt' && node.matches && (node.matches('[data-message-author-role="assistant"]') || node.matches('[data-turn="assistant"]'))) {
      const msgEl = node.querySelector('[class*="markdown"]') || node;
      if (msgEl) tryStampMessage(msgEl);
      return;
    }
    if (node.querySelectorAll && msgSelectorStr) node.querySelectorAll(msgSelectorStr).forEach(el => tryStampMessage(el));
  }

  loadTools().then((ok) => {
    if (!ok) console.warn('[Bracket] Starting without tool commands — start the lifecycle manager and reload the page.');
    new MutationObserver((mutations) => {
      for (const mutation of mutations) for (const node of mutation.addedNodes) stampAndProcess(node);
    }).observe(document.body, { childList: true, subtree: true });
  });

})();