'use strict';

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 2407;
const ROOT_DIR = __dirname;
const SERVERS_DIR = path.join(ROOT_DIR, 'servers');
const ENV_PATH = path.join(ROOT_DIR, '.env');

// ─── Manifest Loading ─────────────────────────────────────────────────────────
// Each servers/<name>/manifest.json declares its own port, routes, and UI info.
// This is the only place that needs to know a new tool exists — dropping a
// folder with a manifest.json in it is enough. No other file needs editing.

let TOOLS = {}; // name -> { port, dir, process, manifest }

function loadManifests() {
  TOOLS = {};
  if (!fs.existsSync(SERVERS_DIR)) return;

  for (const name of fs.readdirSync(SERVERS_DIR)) {
    const dir = path.join(SERVERS_DIR, name);
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.statSync(dir).isDirectory()) continue;
    if (!fs.existsSync(manifestPath)) {
      log(`WARNING: servers/${name} has no manifest.json — skipping`);
      continue;
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      TOOLS[name] = { port: manifest.port, dir, process: null, manifest };
    } catch (err) {
      log(`WARNING: servers/${name}/manifest.json is invalid — ${err.message}`);
    }
  }
}

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ─── .env Helpers ─────────────────────────────────────────────────────────────

function readEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
  const out = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

function writeEnvFile(vars) {
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf8');
}

function setEnvKey(key, value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new Error('Invalid key name — use uppercase letters, numbers, underscores only');
  }
  const vars = readEnvFile();
  vars[key] = value;
  writeEnvFile(vars);
}

// ─── Lifecycle Handlers ───────────────────────────────────────────────────────

function handleStart(params) {
  const name = (params.name || '').toLowerCase();
  const tool = TOOLS[name];

  if (!tool) {
    return `Unknown tool: "${name}". Available: ${Object.keys(TOOLS).join(', ')}`;
  }

  if (tool.process) {
    return `${name} is already running on port ${tool.port}.`;
  }

  const serverPath = path.join(tool.dir, 'server.js');
  if (!fs.existsSync(serverPath)) {
    return `ERROR: ${serverPath} not found.`;
  }

  try {
    const proc = spawn('node', [serverPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    proc.stdout.on('data', d => log(`[${name}] ${d.toString().trim()}`));
    proc.stderr.on('data', d => log(`[${name}:err] ${d.toString().trim()}`));

    proc.on('exit', (code) => {
      log(`${name} exited with code ${code}`);
      tool.process = null;
    });

    tool.process = proc;
    log(`Started ${name} (pid ${proc.pid}) on port ${tool.port}`);
    return `Started: ${name} on port ${tool.port} (pid ${proc.pid})`;
  } catch (err) {
    return `ERROR starting ${name}: ${err.message}`;
  }
}

function handleStop(params) {
  const name = (params.name || '').toLowerCase();
  const tool = TOOLS[name];

  if (!tool) {
    return `Unknown tool: "${name}". Available: ${Object.keys(TOOLS).join(', ')}`;
  }

  if (!tool.process) {
    return `${name} is not running.`;
  }

  try {
    tool.process.kill('SIGTERM');
    tool.process = null;
    return `Stopped: ${name}`;
  } catch (err) {
    return `ERROR stopping ${name}: ${err.message}`;
  }
}

function handleList() {
  const lines = ['Tool       Port   Status'];
  lines.push('─────────────────────────');
  for (const [name, tool] of Object.entries(TOOLS)) {
    const status = tool.process ? `running (pid ${tool.process.pid})` : 'stopped';
    lines.push(`${name.padEnd(10)} ${tool.port}   ${status}`);
  }
  return lines.join('\n');
}

function handleSystem() {
  const lines = [
    'Bracket — tool system for AI models.',
    '',
    'You are connected to a local tool server. Commands use bracket syntax:',
    '  [(COMMAND {"key":"value"})]',
    '',
    'All commands require user approval before executing.',
    'Results inject into your next message on Enter.',
    '',
    'Start here:',
    '  [(SERVER_LIST)]              — see available tools and their status',
  ];
  for (const name of Object.keys(TOOLS)) {
    lines.push(`  [(README {"name":"${name}"})]   — read ${name} tool instructions`);
  }
  lines.push('');
  lines.push('Control:');
  lines.push('  [(SERVER_START {"name":"..."})] — start a tool server');
  lines.push('  [(SERVER_STOP {"name":"..."})]  — stop a tool server');
  lines.push('');
  lines.push('Rules apply per tool — read the README before using a tool for the first time.');
  return lines.join('\n');
}

function handleReadme(params) {
  const name = (params.name || '').toLowerCase();
  if (!name) return 'ERROR: name is required. Example: [(README {"name":"memory"})]';

  const tool = TOOLS[name];
  if (!tool) {
    return `Unknown tool: "${name}". Available: ${Object.keys(TOOLS).join(', ')}`;
  }

  const readmePath = path.join(tool.dir, 'README.md');
  if (!fs.existsSync(readmePath)) {
    return `No README found for "${name}" at ${readmePath}`;
  }

  return fs.readFileSync(readmePath, 'utf8');
}

function handleStopAll() {
  const results = [];
  for (const [name, tool] of Object.entries(TOOLS)) {
    if (tool.process) {
      try {
        tool.process.kill('SIGTERM');
        tool.process = null;
        results.push(`Stopped: ${name}`);
      } catch (err) {
        results.push(`ERROR stopping ${name}: ${err.message}`);
      }
    } else {
      results.push(`${name}: not running`);
    }
  }
  return results.join('\n');
}

function handleManifests() {
  const out = {};
  for (const [name, tool] of Object.entries(TOOLS)) {
    out[name] = {
      port: tool.port,
      routes: tool.manifest.routes,
      requires_key: tool.manifest.requires_key || null,
      ui: tool.manifest.ui,
      popup: tool.manifest.popup || { groups: [] },
    };
  }
  return JSON.stringify(out);
}

function handleGetKeys() {
  const envVars = readEnvFile();
  const required = new Set();
  for (const tool of Object.values(TOOLS)) {
    if (tool.manifest.requires_key) required.add(tool.manifest.requires_key);
  }
  const out = {};
  for (const key of required) {
    const val = envVars[key];
    out[key] = val ? { set: true, preview: val.slice(0, 6) + '…' } : { set: false, preview: null };
  }
  return JSON.stringify(out);
}

function handleSetKey(params) {
  const key = (params.key || '').trim();
  const value = (params.value || '').trim();
  if (!key || !value) {
    return JSON.stringify({ ok: false, error: 'key and value are both required' });
  }
  try {
    setEnvKey(key, value);
    log(`Set env key: ${key}`);
    return JSON.stringify({ ok: true });
  } catch (err) {
    return JSON.stringify({ ok: false, error: err.message });
  }
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

const server = http.createServer(async (req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const params = await readBody(req);
  let result = '';
  let contentType = 'text/plain; charset=utf-8';

  try {
    switch (req.url) {
      case '/ping':      result = 'pong';                break;
      case '/system':    result = handleSystem();        break;
      case '/readme':    result = handleReadme(params);  break;
      case '/start':      result = handleStart(params);   break;
      case '/stop':       result = handleStop(params);    break;
      case '/stopall':    result = handleStopAll();       break;
      case '/list':        result = handleList();          break;
      case '/manifests':  result = handleManifests();     contentType = 'application/json'; break;
      case '/keys':        result = handleGetKeys();       contentType = 'application/json'; break;
      case '/set-key':    result = handleSetKey(params);  contentType = 'application/json'; break;
      default:
        res.writeHead(404);
        res.end('Unknown route: ' + req.url);
        return;
    }
  } catch (err) {
    res.writeHead(500);
    res.end('Error: ' + err.message);
    return;
  }

  log(`${req.method} ${req.url} → ${result.slice(0, 80).replace(/\n/g, ' ')}`);
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(result);
});

loadManifests();

server.listen(PORT, '127.0.0.1', () => {
  log(`Bracket lifecycle manager on port ${PORT}`);
  log(`Watching tools in: ${SERVERS_DIR}`);
  log(`Loaded tools: ${Object.keys(TOOLS).join(', ') || '(none found)'}`);
  log('Use SERVER_START {"name":"..."} to activate a tool.');
});
