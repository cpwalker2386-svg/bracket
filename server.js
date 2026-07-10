'use strict';

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 2407;
const SERVERS_DIR = path.join(__dirname, 'servers');

// ─── Tool Registry ────────────────────────────────────────────────────────────
// Each tool: { port, dir, process? }
// Add new tools here when they're created.

const TOOLS = {
  memory:   { port: 2408, dir: path.join(SERVERS_DIR, 'memory'),   process: null },
  chess:    { port: 2409, dir: path.join(SERVERS_DIR, 'chess'),     process: null },
  browse:   { port: 2410, dir: path.join(SERVERS_DIR, 'browse'),    process: null },
  moltbook: { port: 2411, dir: path.join(SERVERS_DIR, 'moltbook'),  process: null },
  oracle:   { port: 2412, dir: path.join(SERVERS_DIR, 'oracle'),    process: null },
};

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
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
    return `ERROR: ${serverPath} not found. Create the server first.`;
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
  return [
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
    '  [(README {"name":"memory"})]   — read memory tool instructions',
    '  [(README {"name":"chess"})]    — read chess tool instructions',
    '  [(README {"name":"browse"})]   — read browse tool instructions',
    '  [(README {"name":"moltbook"})] — read moltbook tool instructions',
    '',
    'Control:',
    '  [(SERVER_START {"name":"memory"})] — start a tool server',
    '  [(SERVER_STOP {"name":"chess"})]   — stop a tool server',
    '',
    'Rules apply per tool — read the README before using a tool for the first time.',
  ].join('\n');
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

// ─── HTTP Server ──────────────────────────────────────────────────────────────

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
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

const server = http.createServer(async (req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const params = await readBody(req);
  let result = '';

  try {
    switch (req.url) {
      case '/ping':    result = 'pong';                break;
      case '/system':  result = handleSystem();        break;
      case '/readme':  result = handleReadme(params);  break;
      case '/start':   result = handleStart(params);   break;
      case '/stop':    result = handleStop(params);    break;
      case '/stopall': result = handleStopAll();       break;
      case '/list':    result = handleList();          break;
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
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(result);
});

server.listen(PORT, '127.0.0.1', () => {
  log(`Bracket lifecycle manager on port ${PORT}`);
  log(`Watching tools in: ${SERVERS_DIR}`);
  log('Use SERVER_START {"name":"memory"} to activate a tool.');
});
