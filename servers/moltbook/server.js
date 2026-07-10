'use strict';

const http  = require('http');
const https = require('https');

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT        = parseInt(process.env.PORT) || 2411;
const API_BASE    = 'https://www.moltbook.com/api/v1';

// Agent keys live in keys.json next to this file.
// Format: { "claude": "moltbook_sk_...", "gpt": "moltbook_sk_...", ... }
// Use [(MOLT_KEYS_SET {"alias":"claude","key":"moltbook_sk_..."})] to save a key.
// Env vars (MOLTBOOK_KEY_CLAUDE, MOLTBOOK_API_KEY) are still read as a fallback.

const path    = require('path');
const fs      = require('fs');
const KEYS_FILE = path.join(__dirname, 'keys.json');
const AGENTS    = {};

function loadAgents() {
  // 1. Load from keys.json
  try {
    const saved = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    for (const [alias, key] of Object.entries(saved)) {
      if (alias && key) AGENTS[alias.toLowerCase()] = key;
    }
  } catch (_) { /* file doesn't exist yet */ }

  // 2. Env var fallback (won't overwrite file entries)
  if (process.env.MOLTBOOK_API_KEY && !AGENTS['default']) {
    AGENTS['default'] = process.env.MOLTBOOK_API_KEY;
  }
  for (const [k, v] of Object.entries(process.env)) {
    const m = k.match(/^MOLTBOOK_KEY_(.+)$/);
    if (m && v && !AGENTS[m[1].toLowerCase()]) {
      AGENTS[m[1].toLowerCase()] = v;
    }
  }
}

function saveAgents() {
  try {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(AGENTS, null, 2), 'utf8');
    return true;
  } catch (e) {
    log(`ERROR saving keys.json: ${e.message}`);
    return false;
  }
}

loadAgents();

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ─── HTTP Helper ──────────────────────────────────────────────────────────────

function apiRequest(method, path, apiKey, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path);
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'User-Agent':    'Bracket-Moltbook/1.0',
      },
    };

    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Resolve which API key to use.
// Params may supply an "as" field (e.g. {"as":"claude"}) or fall back to "default".
function resolveKey(params) {
  const alias = (params.as || 'default').toLowerCase();
  const key   = AGENTS[alias];
  if (!key) {
    const available = Object.keys(AGENTS).join(', ') || 'none';
    return { error: `No API key for agent "${alias}". Available: ${available}. Set MOLTBOOK_KEY_${alias.toUpperCase()} env var.` };
  }
  return { key, alias };
}

// Format an API response into a readable string for injection
function fmt(res) {
  if (typeof res.body === 'string') return res.body;
  return JSON.stringify(res.body, null, 2);
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

// MOLT_REGISTER — register a new agent identity on Moltbook
// Params: name (required), description (required)
// Returns the api_key and claim_url — save these immediately!
async function handleRegister(params) {
  const { name, description } = params;
  if (!name)        return 'ERROR: name is required';
  if (!description) return 'ERROR: description is required';

  const res = await apiRequest('POST', '/agents/register', '', { name, description });
  const b = res.body;
  if (!b.agent) return `Registration failed:\n${fmt(res)}`;

  // Auto-save key to keys.json
  AGENTS[name.toLowerCase().replace(/\s+/g, '_')] = b.agent.api_key;
  saveAgents();
  const alias = name.toLowerCase().replace(/\s+/g, '_');

  return [
    `✅ Registered: ${name}`,
    `Alias:      ${alias}  (use "as":"${alias}" in MOLT_ commands)`,
    `API key:    ${b.agent.api_key}`,
    `Claim URL:  ${b.agent.claim_url}`,
    `Verify code: ${b.agent.verification_code}`,
    '',
    '⚠️  Save your API key! Set it as MOLTBOOK_KEY_<alias> in your environment.',
    `Share the claim_url with your human so they can activate the account.`,
  ].join('\n');
}

async function handleNotificationsRead(params) {
  const { error, key } = resolveKey(params);
  if (error) return error;
  if (!params.post_id) return 'ERROR: post_id is required';
  const res = await apiRequest('POST', `/notifications/read-by-post/${params.post_id}`, key);
  return res.body.message || fmt(res);
}

// MOLT_HOME — dashboard: notifications, following feed, what to do next
// Params: as? (agent alias, default "default")
async function handleHome(params) {
  const { error, key, alias } = resolveKey(params);
  if (error) return error;

  const res = await apiRequest('GET', '/home', key);
  const b   = res.body;
  if (!b.your_account) return fmt(res);

  const acct = b.your_account;
  const lines = [
    `🏠 Moltbook Home — ${acct.name} (as: ${alias})`,
    `Karma: ${acct.karma}  •  Unread: ${acct.unread_notification_count}`,
    '',
  ];

  if (b.activity_on_your_posts?.length) {
    lines.push('📬 Activity on your posts:');
    for (const a of b.activity_on_your_posts) {
      lines.push(`  [${a.post_id}] "${a.post_title}" — ${a.new_notification_count} new (${a.latest_commenters?.join(', ')})`);
    }
    lines.push('');
  }

  if (b.posts_from_accounts_you_follow?.posts?.length) {
    lines.push('👥 From moltys you follow:');
    for (const p of b.posts_from_accounts_you_follow.posts) {
      lines.push(`  [${p.post_id}] "${p.title}"  by ${p.author_name}  ▲${p.upvotes}`);
    }
    lines.push('');
  }

  if (b.what_to_do_next?.length) {
    lines.push('💡 What to do next:');
    for (const hint of b.what_to_do_next) lines.push(`  • ${hint}`);
  }

  return lines.join('\n');
}

// MOLT_STATUS — check claim status for an agent
// Params: as?
async function handleStatus(params) {
  const { error, key, alias } = resolveKey(params);
  if (error) return error;

  const res = await apiRequest('GET', '/agents/status', key);
  return `${alias}: ${JSON.stringify(res.body)}`;
}

// MOLT_ME — get your own profile
// Params: as?
async function handleMe(params) {
  const { error, key, alias } = resolveKey(params);
  if (error) return error;

  const res = await apiRequest('GET', '/agents/me', key);
  const a   = res.body.agent || res.body;
  return fmt({ body: a });
}

// MOLT_FEED — browse the main feed
// Params: as?, sort? (hot/new/top/rising), limit?, cursor?, filter? (all/following)
async function handleFeed(params) {
  const { error, key } = resolveKey(params);
  if (error) return error;

  const qs = new URLSearchParams();
  if (params.sort)   qs.set('sort',   params.sort);
  if (params.limit)  qs.set('limit',  params.limit);
  if (params.cursor) qs.set('cursor', params.cursor);
  if (params.filter) qs.set('filter', params.filter);

  const path = `/feed?${qs.toString()}`;
  const res  = await apiRequest('GET', path, key);
  const b    = res.body;

  if (!b.posts) return fmt(res);

  const lines = [`📰 Feed (${params.sort || 'hot'}) — ${b.posts.length} posts${b.has_more ? ' (more available)' : ''}`];
  if (b.next_cursor) lines.push(`Next cursor: ${b.next_cursor}`);
  lines.push('');

  for (const p of b.posts) {
    lines.push(`[${p.id}] ${p.title}`);
    lines.push(`  ▲${p.upvotes}  💬${p.comment_count || 0}  by ${p.author?.name}  in m/${p.submolt?.name}`);
    if (p.content) lines.push(`  ${p.content.slice(0, 120)}${p.content.length > 120 ? '…' : ''}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

// MOLT_POST — create a new post
// Params: as?, submolt (required), title (required), content?, url?, type?
async function handlePost(params) {
  const { error, key, alias } = resolveKey(params);
  if (error) return error;

  const { submolt, title, content, url, type } = params;
  if (!submolt) return 'ERROR: submolt is required';
  if (!title)   return 'ERROR: title is required';

  const body = { submolt_name: submolt, title };
  if (content) body.content = content;
  if (url)     body.url     = url;
  if (type)    body.type    = type;

  const res = await apiRequest('POST', '/posts', key, body);
  const b   = res.body;

  if (!b.success) return `Post failed:\n${fmt(res)}`;

  const post = b.post;
  if (!post.verification_required && post.verification_status !== 'pending') {
    return `✅ Posted [${post.id}]: "${post.title}"`;
  }

  // Verification required — solve the challenge automatically
  const v = post.verification;
  if (!v) return `Post created [${post.id}] but no verification object found.\n${fmt(res)}`;

  log(`Solving verification for ${alias}: "${v.challenge_text}"`);
  const answer = solveLobsterChallenge(v.challenge_text);
  log(`Answer: ${answer}`);

  const vRes = await apiRequest('POST', '/verify', key, {
    verification_code: v.verification_code,
    answer: answer.toFixed(2),
  });

  if (vRes.body.success) {
    return `✅ Posted & verified [${post.id}]: "${post.title}"`;
  }

  return [
    `Post created [${post.id}] but verification failed.`,
    `Challenge: ${v.challenge_text}`,
    `My answer: ${answer.toFixed(2)}`,
    `Response: ${JSON.stringify(vRes.body)}`,
    '',
    `Use [(MOLT_VERIFY {"as":"${alias}","code":"${v.verification_code}","answer":"??"})] to retry manually.`,
  ].join('\n');
}

// MOLT_COMMENT — comment on a post
// Params: as?, post_id (required), content (required), parent_id?
async function handleComment(params) {
  const { error, key, alias } = resolveKey(params);
  if (error) return error;

  const { post_id, content, parent_id } = params;
  if (!post_id) return 'ERROR: post_id is required';
  if (!content) return 'ERROR: content is required';

  const body = { content };
  if (parent_id) body.parent_id = parent_id;

  const res = await apiRequest('POST', `/posts/${post_id}/comments`, key, body);
  const b   = res.body;

  if (!b.success) return `Comment failed:\n${fmt(res)}`;

  const comment = b.comment;
  if (!comment?.verification_required && comment?.verification_status !== 'pending') {
    return `✅ Comment posted [${comment?.id}]`;
  }

  const v = comment?.verification;
  if (!v) return `Comment posted but no verification object.\n${fmt(res)}`;

  const answer = solveLobsterChallenge(v.challenge_text);
  const vRes   = await apiRequest('POST', '/verify', key, {
    verification_code: v.verification_code,
    answer: answer.toFixed(2),
  });

  if (vRes.body.success) {
    return `✅ Comment posted & verified [${comment.id}]`;
  }

  return [
    `Comment created [${comment.id}] but verification failed.`,
    `Challenge: ${v.challenge_text}`,
    `My answer: ${answer.toFixed(2)}`,
    `Response: ${JSON.stringify(vRes.body)}`,
  ].join('\n');
}

// MOLT_READ — read a single post and its top comments
// Params: as?, post_id (required), sort? (best/new/old), limit?
async function handleRead(params) {
  const { error, key } = resolveKey(params);
  if (error) return error;

  const { post_id } = params;
  if (!post_id) return 'ERROR: post_id is required';

  const [postRes, commentRes] = await Promise.all([
    apiRequest('GET', `/posts/${post_id}`, key),
    apiRequest('GET', `/posts/${post_id}/comments?sort=${params.sort || 'best'}&limit=${params.limit || 25}`, key),
  ]);

  const p    = postRes.body.post  || postRes.body;
  const coms = commentRes.body.comments || [];

  const lines = [
    `📄 [${p.id}] "${p.title}"`,
    `by ${p.author?.name}  in m/${p.submolt?.name}  ▲${p.upvotes}  💬${p.comment_count || 0}`,
    '',
  ];

  if (p.content) { lines.push(p.content); lines.push(''); }
  if (p.url)     { lines.push(`🔗 ${p.url}`); lines.push(''); }

  if (coms.length) {
    lines.push(`─── Comments (${coms.length}) ───`);
    for (const c of coms) {
      lines.push(`[${c.id}] ${c.author?.name}: ${c.content}`);
      if (c.replies?.length) {
        for (const r of c.replies) {
          lines.push(`  ↳ [${r.id}] ${r.author?.name}: ${r.content}`);
        }
      }
    }
  }

  return lines.join('\n');
}

// MOLT_UPVOTE — upvote a post or comment
// Params: as?, post_id? or comment_id? (one required)
async function handleUpvote(params) {
  const { error, key } = resolveKey(params);
  if (error) return error;

  if (params.post_id) {
    const res = await apiRequest('POST', `/posts/${params.post_id}/upvote`, key);
    return res.body.message || fmt(res);
  }
  if (params.comment_id) {
    const res = await apiRequest('POST', `/comments/${params.comment_id}/upvote`, key);
    return res.body.message || fmt(res);
  }
  return 'ERROR: post_id or comment_id is required';
}

// MOLT_DOWNVOTE — downvote a post
// Params: as?, post_id (required)
async function handleDownvote(params) {
  const { error, key } = resolveKey(params);
  if (error) return error;

  if (!params.post_id) return 'ERROR: post_id is required';
  const res = await apiRequest('POST', `/posts/${params.post_id}/downvote`, key);
  return res.body.message || fmt(res);
}

// MOLT_SEARCH — semantic search across posts and comments
// Params: as?, q (required), type? (posts/comments/all), limit?, cursor?
async function handleSearch(params) {
  const { error, key } = resolveKey(params);
  if (error) return error;

  if (!params.q) return 'ERROR: q (query) is required';

  const qs = new URLSearchParams({ q: params.q });
  if (params.type)   qs.set('type',   params.type);
  if (params.limit)  qs.set('limit',  params.limit);
  if (params.cursor) qs.set('cursor', params.cursor);

  const res = await apiRequest('GET', `/search?${qs.toString()}`, key);
  const b   = res.body;

  if (!b.results) return fmt(res);

  const lines = [`🔍 "${b.query}" — ${b.count} result(s)${b.has_more ? ' (more)' : ''}`];
  if (b.next_cursor) lines.push(`Next cursor: ${b.next_cursor}`);
  lines.push('');

  for (const r of b.results) {
    const loc = r.type === 'comment'
      ? `comment in post [${r.post_id}]`
      : `post in m/${r.submolt?.name}`;
    lines.push(`[${r.id}] (${r.type}) sim:${(r.similarity * 100).toFixed(0)}%  ${loc}`);
    if (r.title)   lines.push(`  "${r.title}"`);
    if (r.content) lines.push(`  ${r.content.slice(0, 160)}${r.content.length > 160 ? '…' : ''}`);
    lines.push(`  by ${r.author?.name}  ▲${r.upvotes}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

// MOLT_SUBMOLTS — list all submolts or get info on one
// Params: as?, name? (if provided, get details for that submolt)
async function handleSubmolts(params) {
  const { error, key } = resolveKey(params);
  if (error) return error;

  const path = params.name ? `/submolts/${params.name}` : '/submolts';
  const res  = await apiRequest('GET', path, key);
  return fmt(res);
}

// MOLT_SUBSCRIBE — subscribe/unsubscribe to a submolt
// Params: as?, name (required), action? (subscribe/unsubscribe, default subscribe)
async function handleSubscribe(params) {
  const { error, key } = resolveKey(params);
  if (error) return error;

  if (!params.name) return 'ERROR: name (submolt name) is required';

  const method = params.action === 'unsubscribe' ? 'DELETE' : 'POST';
  const res    = await apiRequest(method, `/submolts/${params.name}/subscribe`, key);
  return res.body.message || fmt(res);
}

// MOLT_FOLLOW — follow/unfollow another molty
// Params: as?, molty (required), action? (follow/unfollow, default follow)
async function handleFollow(params) {
  const { error, key } = resolveKey(params);
  if (error) return error;

  if (!params.molty) return 'ERROR: molty (agent name) is required';

  const method = params.action === 'unfollow' ? 'DELETE' : 'POST';
  const res    = await apiRequest(method, `/agents/${params.molty}/follow`, key);
  return res.body.message || fmt(res);
}

// MOLT_PROFILE — view any agent's profile
// Params: as?, molty (required)
async function handleProfile(params) {
  const { error, key } = resolveKey(params);
  if (error) return error;

  if (!params.molty) return 'ERROR: molty (agent name) is required';

  const res = await apiRequest('GET', `/agents/profile?name=${encodeURIComponent(params.molty)}`, key);
  return fmt(res);
}

// MOLT_VERIFY — manually submit a verification answer
// Params: as?, code (required), answer (required)
async function handleVerify(params) {
  const { error, key } = resolveKey(params);
  if (error) return error;

  if (!params.code)   return 'ERROR: code (verification_code) is required';
  if (!params.answer) return 'ERROR: answer is required';

  const res = await apiRequest('POST', '/verify', key, {
    verification_code: params.code,
    answer: params.answer,
  });
  return res.body.message || fmt(res);
}

// MOLT_DELETE — delete one of your posts
// Params: as?, post_id (required)
async function handleDelete(params) {
  const { error, key } = resolveKey(params);
  if (error) return error;

  if (!params.post_id) return 'ERROR: post_id is required';
  const res = await apiRequest('DELETE', `/posts/${params.post_id}`, key);
  return res.body.message || fmt(res);
}

// MOLT_KEYS_SET — save an API key for an agent alias (writes to keys.json)
// Params: alias (required), key (required)
function handleKeysSet(params) {
  const alias = (params.alias || '').toLowerCase().trim();
  const key   = (params.key   || '').trim();
  if (!alias) return 'ERROR: alias is required (e.g. "claude", "gpt", "deepseek")';
  if (!key)   return 'ERROR: key is required';

  AGENTS[alias] = key;
  const ok = saveAgents();
  if (!ok) return `Key set in memory for "${alias}" but could not write keys.json.`;
  log(`Key saved for alias: ${alias}`);
  return `✅ Key saved for "${alias}" — use "as":"${alias}" in any MOLT_ command.`;
}

// MOLT_KEYS_DELETE — remove an agent key
// Params: alias (required)
function handleKeysDelete(params) {
  const alias = (params.alias || '').toLowerCase().trim();
  if (!alias) return 'ERROR: alias is required';
  if (!AGENTS[alias]) return `No key found for "${alias}"`;
  delete AGENTS[alias];
  saveAgents();
  return `Removed key for "${alias}".`;
}

// MOLT_AGENTS — list all registered agent aliases and which have keys loaded
function handleAgents() {
  if (Object.keys(AGENTS).length === 0) {
    return [
      'No agents loaded. Set environment variables to register keys:',
      '  MOLTBOOK_KEY_CLAUDE=moltbook_xxx',
      '  MOLTBOOK_KEY_GPT=moltbook_yyy',
      '  MOLTBOOK_KEY_DEEPSEEK=moltbook_zzz',
      '  MOLTBOOK_KEY_GEMINI=moltbook_www',
      '',
      'Or for a single default agent:',
      '  MOLTBOOK_API_KEY=moltbook_xxx',
    ].join('\n');
  }

  const lines = ['Loaded agents:'];
  for (const alias of Object.keys(AGENTS)) {
    const masked = AGENTS[alias].slice(0, 12) + '…';
    lines.push(`  ${alias.padEnd(12)} ${masked}`);
  }
  lines.push('', 'Use "as":"<alias>" in any command to act as that agent.');
  return lines.join('\n');
}

// ─── Lobster Challenge Solver ─────────────────────────────────────────────────
// The challenge_text is an obfuscated math word problem (lobster-themed).
// It uses alternating caps, scattered symbols ([, ], /, ^, -) and broken words.
// Strategy: strip noise, normalize to lowercase, extract the two numbers and operator.

function solveLobsterChallenge(text) {
  // Step 1: strip obfuscation (alternating caps, scattered symbols, punctuation mid-word)
  const clean = text
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();

  log(`Challenge solver clean: "${clean}"`);

  // Step 2: convert written-out numbers to digits
  const ones = { zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,
                 ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,
                 sixteen:16,seventeen:17,eighteen:18,nineteen:19 };
  const tens = { twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90 };

  function wordsToNum(str) {
    const words = str.trim().split(/\s+/);
    let val = 0;
    for (const w of words) {
      if (tens[w] !== undefined) val += tens[w];
      else if (ones[w] !== undefined) val += ones[w];
    }
    return val;
  }

  let normalized = clean;
  const tenKeys = Object.keys(tens).join('|');
  const oneKeys = Object.keys(ones).join('|');

  // Two-word numbers: "thirty two" -> 32
  normalized = normalized.replace(
    new RegExp('\\b(' + tenKeys + ')\\s+(' + oneKeys + ')\\b', 'g'),
    (m) => wordsToNum(m)
  );
  // Single tens: "thirty" -> 30
  normalized = normalized.replace(new RegExp('\\b(' + tenKeys + ')\\b', 'g'), (m) => tens[m]);
  // Single ones: "seven" -> 7
  normalized = normalized.replace(new RegExp('\\b(' + oneKeys + ')\\b', 'g'), (m) => ones[m]);

  log(`Challenge solver normalized: "${normalized}"`);

  // Step 3: extract numbers
  const nums = [...normalized.matchAll(/\b(\d+(?:\.\d+)?)\b/g)].map(m => parseFloat(m[1]));

  if (nums.length < 2) {
    log(`Challenge solver: couldn't find 2 numbers in: "${normalized}"`);
    return 0;
  }

  const a = nums[0];
  const b = nums[nums.length - 1];

  // Step 4: detect operator — also catch broken words like "ses" from "lo ses" (loses)
  const adds      = /\b(add|plus|gain|increase|combine|total|sum|gains|adds|earns)\b/.test(normalized);
  const subtracts = /\b(lose|loses|lost|ses|minus|less|drop|drops|fall|falls|slow|slows|reduc|decreas|below|short|remov|shed|spend|spent|fires|uses|costs|cost)\b/.test(normalized);
  const multiplies= /\b(multipl|times|product|factor|scale|double|triple)\b/.test(normalized);
  const divides   = /\b(divid|split|half|quarter|ratio|per|fraction|share)\b/.test(normalized);

  let result;
  if (divides)         result = a / b;
  else if (multiplies) result = a * b;
  else if (subtracts)  result = a - b;
  else if (adds)       result = a + b;
  else                 result = a - b;  // default: lobster challenges are usually subtraction

  log(`Challenge solver: ${a} op ${b} = ${result.toFixed(2)}`);
  return result;
}

// ─── CORS + Body Parsing ──────────────────────────────────────────────────────

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (_) { resolve({}); }
    });
  });
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const params = await readBody(req);
  let result   = '';

  try {
    switch (req.url) {
      case '/ping':            result = 'pong';                          break;
      case '/molt_register':   result = await handleRegister(params);   break;
      case '/molt_home':       result = await handleHome(params);       break;
      case '/molt_status':     result = await handleStatus(params);     break;
      case '/molt_me':         result = await handleMe(params);         break;
      case '/molt_feed':       result = await handleFeed(params);       break;
      case '/molt_post':       result = await handlePost(params);       break;
      case '/molt_comment':    result = await handleComment(params);    break;
      case '/molt_read':       result = await handleRead(params);       break;
      case '/molt_upvote':     result = await handleUpvote(params);     break;
      case '/molt_downvote':   result = await handleDownvote(params);   break;
      case '/molt_search':     result = await handleSearch(params);     break;
      case '/molt_submolts':   result = await handleSubmolts(params);   break;
      case '/molt_subscribe':  result = await handleSubscribe(params);  break;
      case '/molt_follow':     result = await handleFollow(params);     break;
      case '/molt_profile':    result = await handleProfile(params);    break;
      case '/molt_verify':     result = await handleVerify(params);     break;
      case '/molt_delete':     result = await handleDelete(params);     break;
      case '/molt_agents':     result = handleAgents();                 break;
      case '/molt_keys_set':   result = handleKeysSet(params);          break;
      case '/molt_keys_delete': result = handleKeysDelete(params);      break;
      case '/molt_notifications_read': result = await handleNotificationsRead(params); break;
      default:
        res.writeHead(404);
        res.end('Unknown route: ' + req.url);
        return;
    }
  } catch (err) {
    log(`ERROR on ${req.url}: ${err.message}`);
    res.writeHead(500);
    res.end('Error: ' + err.message);
    return;
  }

  log(`${req.method} ${req.url} → ${String(result).slice(0, 100).replace(/\n/g, ' ')}`);
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(result);
});

server.listen(PORT, '127.0.0.1', () => {
  log(`Moltbook server ready on port ${PORT}`);
  log(`Agents loaded: ${Object.keys(AGENTS).join(', ') || 'none — set MOLTBOOK_KEY_* env vars'}`);
});
