'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

// ─── Config ───────────────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MEMORY_ROOT   = 'D:\\AI_Memory';
const MEMORIES_DIR  = path.join(MEMORY_ROOT, 'memories');
const TAG_INDEX_PATH   = path.join(MEMORY_ROOT, 'tag_index.json');
const RETRIEVAL_LOG_PATH = path.join(MEMORY_ROOT, 'retrieval_log.json');
const PORT = parseInt(process.env.PORT) || 2408;

// ─── Startup ──────────────────────────────────────────────────────────────────

fs.mkdirSync(MEMORIES_DIR, { recursive: true });

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readJSON(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); }
  catch { return null; }
}

function writeJSON(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
}

function parseTags(raw) {
  if (!raw) return [];
  if (typeof raw === 'string') {
    return raw.split(',').map(t => t.trim()).filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return raw.map(t => String(t).trim()).filter(Boolean);
  }
  return [];
}

function safeFilename(str) {
  return str.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 80);
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

function handleStore(params) {
  const tags       = parseTags(params.tags);
  const confidence = parseFloat(params.confidence) || 0.9;
  const importance = params.importance || 'medium';
  const model      = params.model || 'unknown';
  const recipe     = params.recipe || '';
  const pointers   = parseTags(params.pointers);
  const requires   = parseTags(params.requires);

  if (!recipe) return 'ERROR: recipe is required';
  if (tags.length === 0) return 'ERROR: at least one tag is required';

  // Validate that all required memories exist
  const missing = [];
  for (const reqFile of requires) {
    let filePath = path.join(MEMORIES_DIR, reqFile);
    if (!filePath.endsWith('.json')) filePath += '.json';
    if (!fs.existsSync(filePath)) {
      missing.push(reqFile + (reqFile.endsWith('.json') ? '' : '.json'));
    }
  }
  if (missing.length > 0) {
    return `ERROR: Required memory not found: ${missing.join(', ')}`;
  }

  const now       = new Date();
  const timestamp = now.toISOString();
  const fileTs    = timestamp.replace(/:/g, '-').replace(/\..+/, '');
  const tagSlug   = safeFilename(tags.slice(0, 3).join('_'));
  const filename  = `${fileTs}_${tagSlug}_c${Math.round(confidence * 100)}.json`;
  const filepath  = path.join(MEMORIES_DIR, filename);

  const memory = {
    timestamp,
    model,
    tags,
    recipe,
    confidence,
    importance,
    pointers,
    requires: requires.map(r => r.endsWith('.json') ? r : r + '.json'),
  };

  writeJSON(filepath, memory);

  // Update tag index
  const index = readJSON(TAG_INDEX_PATH) || { tags: {} };
  if (!index.tags) index.tags = {};
  for (const tag of tags) {
    if (!index.tags[tag]) {
      index.tags[tag] = { count: 0, first_used: timestamp, last_used: timestamp };
    }
    index.tags[tag].count++;
    index.tags[tag].last_used = timestamp;
  }
  writeJSON(TAG_INDEX_PATH, index);

  return `Stored: ${filename}\nTags: ${tags.join(', ')}\nConfidence: ${confidence}\nImportance: ${importance}`;
}

function handleSearch(params) {
  const tags      = parseTags(params.tags);
  const since     = params.since ? new Date(params.since) : null;
  const until     = params.until ? new Date(params.until) : null;
  const minConf   = parseFloat(params.min_confidence) || 0;
  const limit     = parseInt(params.limit) || 20;

  const files = fs.readdirSync(MEMORIES_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  const results = [];

  for (const file of files) {
    const data = readJSON(path.join(MEMORIES_DIR, file));
    if (!data) continue;

    if (tags.length > 0 && !tags.every(t => data.tags && data.tags.includes(t))) continue;

    const ts = new Date(data.timestamp);
    if (since && ts < since) continue;
    if (until && ts > until) continue;

    if (data.confidence < minConf) continue;

    results.push({
      file,
      timestamp: data.timestamp,
      tags: data.tags,
      confidence: data.confidence,
      importance: data.importance,
      model: data.model,
    });

    if (results.length >= limit) break;
  }

  return JSON.stringify(results, null, 2);
}

function handleList(params) {
  const limit = parseInt(params.limit) || 20;
  const files = fs.readdirSync(MEMORIES_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit);

  const results = files.map(f => {
    const data = readJSON(path.join(MEMORIES_DIR, f));
    return {
      file: f,
      timestamp: data?.timestamp,
      tags: data?.tags,
      confidence: data?.confidence,
      importance: data?.importance,
    };
  });

  return JSON.stringify(results, null, 2);
}

function handleRead(params) {
  if (!params.id) return 'ERROR: id is required';

  let filepath = path.join(MEMORIES_DIR, params.id);
  if (!filepath.endsWith('.json')) filepath += '.json';

  if (!fs.existsSync(filepath)) return `ERROR: Memory not found: ${params.id}`;
  return fs.readFileSync(filepath, 'utf8');
}

function handleReadWithRequires(params) {
  if (!params.id) return 'ERROR: id is required';

  let filepath = path.join(MEMORIES_DIR, params.id);
  if (!filepath.endsWith('.json')) filepath += '.json';

  if (!fs.existsSync(filepath)) return `ERROR: Memory not found: ${params.id}`;

  const mainMemory = readJSON(filepath);
  if (!mainMemory) return 'ERROR: Could not parse memory';

  const requiredContent = [];
  if (Array.isArray(mainMemory.requires)) {
    for (const reqFile of mainMemory.requires) {
      let reqPath = path.join(MEMORIES_DIR, reqFile);
      if (!reqPath.endsWith('.json')) reqPath += '.json';
      if (fs.existsSync(reqPath)) {
        const reqMem = readJSON(reqPath);
        if (reqMem) {
          requiredContent.push({
            file: reqFile,
            recipe: reqMem.recipe,
            tags: reqMem.tags,
            confidence: reqMem.confidence,
            importance: reqMem.importance,
            pointers: reqMem.pointers,
          });
        } else {
          requiredContent.push({ file: reqFile, error: 'Failed to parse' });
        }
      } else {
        requiredContent.push({ file: reqFile, error: 'File not found' });
      }
    }
  }

  const result = {
    memory: mainMemory,
    requires_content: requiredContent,
  };

  return JSON.stringify(result, null, 2);
}

function handleTagIndex() {
  if (!fs.existsSync(TAG_INDEX_PATH)) return JSON.stringify({ tags: {} }, null, 2);
  return fs.readFileSync(TAG_INDEX_PATH, 'utf8');
}

function handleExists(params) {
  const tags   = parseTags(params.tags);
  const recipe = (params.recipe || '').trim().slice(0, 100);
  if (!recipe && tags.length === 0) return 'false';
  const files = fs.readdirSync(MEMORIES_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const data = readJSON(path.join(MEMORIES_DIR, file));
    if (!data) continue;
    const tagsMatch = tags.length === 0 || (data.tags && tags.every(t => data.tags.includes(t)));
    const recipeMatch = recipe.length === 0 || (data.recipe && data.recipe.trim().slice(0, 100) === recipe);
    if (tagsMatch && recipeMatch) return 'true';
  }
  return 'false';
}

// ─── UPDATE handler ───────────────────────────────────────────────────────────

function handleUpdate(params) {
  if (!params.id) return 'ERROR: id is required';

  let filepath = path.join(MEMORIES_DIR, params.id);
  if (!filepath.endsWith('.json')) filepath += '.json';

  if (!fs.existsSync(filepath)) return `ERROR: Memory not found: ${params.id}`;

  const memory = readJSON(filepath);
  if (!memory) return 'ERROR: Could not parse memory';

  const oldTags = Array.isArray(memory.tags) ? memory.tags : [];

  // Merge fields — only overwrite what was provided
  if (params.tags !== undefined)    memory.tags      = parseTags(params.tags);
  if (params.recipe !== undefined)  memory.recipe    = params.recipe;
  if (params.confidence !== undefined) memory.confidence = parseFloat(params.confidence);
  if (params.importance !== undefined) memory.importance = params.importance;
  if (params.model !== undefined)   memory.model     = params.model;
  if (params.pointers !== undefined) memory.pointers  = parseTags(params.pointers);
  if (params.requires !== undefined) {
    const requires = parseTags(params.requires);
    // Validate that all required memories exist
    const missing = [];
    for (const reqFile of requires) {
      let reqPath = path.join(MEMORIES_DIR, reqFile);
      if (!reqPath.endsWith('.json')) reqPath += '.json';
      if (!fs.existsSync(reqPath)) {
        missing.push(reqFile + (reqFile.endsWith('.json') ? '' : '.json'));
      }
    }
    if (missing.length > 0) {
      return `ERROR: Required memory not found: ${missing.join(', ')}`;
    }
    memory.requires = requires.map(r => r.endsWith('.json') ? r : r + '.json');
  }

  writeJSON(filepath, memory);

  // Tag index diff: if tags changed, update the index
  const newTags = Array.isArray(memory.tags) ? memory.tags : [];
  const index = readJSON(TAG_INDEX_PATH) || { tags: {} };
  if (!index.tags) index.tags = {};

  // Decrement old tags
  for (const tag of oldTags) {
    if (!newTags.includes(tag) && index.tags[tag]) {
      index.tags[tag].count--;
      if (index.tags[tag].count <= 0) {
        delete index.tags[tag];
      }
    }
  }

  // Add / increment new tags
  for (const tag of newTags) {
    if (!index.tags[tag]) {
      index.tags[tag] = { count: 0, first_used: memory.timestamp, last_used: memory.timestamp };
    }
    index.tags[tag].count++;
    index.tags[tag].last_used = new Date().toISOString();
  }

  writeJSON(TAG_INDEX_PATH, index);

  return `Updated: ${params.id}\nTags: ${newTags.join(', ')}\nConfidence: ${memory.confidence}\nImportance: ${memory.importance}`;
}

// ─── RECONSTRUCT handler ──────────────────────────────────────────────────────

async function handleReconstruct(params) {
  const recipe     = (params.recipe || '').trim();
  const tags       = parseTags(params.tags);
  const confidence = parseFloat(params.confidence) || 0.9;
  const importance = params.importance || 'medium';
  const requires   = parseTags(params.requires);
  const pointers   = parseTags(params.pointers);

  if (!recipe) return 'ERROR: recipe is required for reconstruction';

  // Build requires context — same as what a future model would see at retrieval
  const requiresContext = [];
  for (const reqFile of requires) {
    let reqPath = path.join(MEMORIES_DIR, reqFile);
    if (!reqPath.endsWith('.json')) reqPath += '.json';
    if (fs.existsSync(reqPath)) {
      const reqMem = readJSON(reqPath);
      if (reqMem) requiresContext.push(`[${reqFile}]: ${reqMem.recipe}`);
    }
  }

  const contextBlock = requiresContext.length > 0
    ? `\n\nRequired context (load-bearing memories this seed depends on):\n${requiresContext.join('\n')}`
    : '';

  const prompt = `Tell me what happened from this seed, in your own words.

Seed: ${recipe}
Tags: ${tags.join(', ')}
Confidence: ${confidence} | Importance: ${importance}${contextBlock}

Reconstruction:`;

  const GEMINI_MODELS = [
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.1-flash',
  ];

  const geminiBody = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 8192, temperature: 0.3 },
  });

  const https = require('https');

  async function tryGeminiModel(model) {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent');
    return new Promise((resolve) => {
      const bodyBuf = Buffer.from(geminiBody, 'utf8');
      const req = https.request({
        hostname: url.hostname,
        path:     url.pathname,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': bodyBuf.length,
          'x-goog-api-key': GEMINI_API_KEY,
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            log('Gemini [' + model + '] raw: ' + JSON.stringify(parsed).slice(0, 200));
            if (parsed.error) {
              const code = parsed.error.code;
              if (code === 503 || code === 429) {
                resolve({ retry: true, reason: code + ' — ' + parsed.error.message });
              } else {
                resolve({ retry: false, text: 'ERROR: Gemini API error ' + code + ' — ' + parsed.error.message });
              }
              return;
            }
            const text = parsed && parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content && parsed.candidates[0].content.parts && parsed.candidates[0].content.parts[0] && parsed.candidates[0].content.parts[0].text;
            resolve({ retry: false, text: (text && text.trim()) || 'ERROR: No text in Gemini response' });
          } catch (e) {
            resolve({ retry: false, text: 'ERROR: Failed to parse Gemini response — ' + e.message });
          }
        });
      });
      req.on('error', e => resolve({ retry: true, reason: 'Network error — ' + e.message }));
      req.write(bodyBuf);
      req.end();
    });
  }

  let reconstruction = 'ERROR: All Gemini models unavailable';
  for (const model of GEMINI_MODELS) {
    const result = await tryGeminiModel(model);
    if (!result.retry) {
      reconstruction = result.text;
      if (!reconstruction.startsWith('ERROR')) log('Gemini: succeeded with ' + model);
      break;
    }
    log('Gemini: ' + model + ' unavailable (' + result.reason + '), trying next…');
  }

    // Similarity signal: rough word overlap between seed and reconstruction
  const seedWords   = new Set(recipe.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const reconWords  = new Set(reconstruction.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const overlap     = [...seedWords].filter(w => reconWords.has(w)).length;
  const fidelity    = seedWords.size > 0 ? Math.round((overlap / seedWords.size) * 100) : 0;
  const signal      = fidelity >= 60 ? 'faithful' : fidelity >= 35 ? 'partial' : 'diverged';

  return [
    `RECONSTRUCTION [${signal} — ${fidelity}% seed overlap]`,
    '─'.repeat(40),
    reconstruction,
    '',
    `Seed: ${recipe.slice(0, 120)}${recipe.length > 120 ? '…' : ''}`,
    `Tags: ${tags.join(', ')} | Confidence: ${confidence} | Importance: ${importance}`,
  ].join('\n');
}

// ─── Server ───────────────────────────────────────────────────────────────────

const HANDLERS = {
  '/ping':               () => 'pong',
  '/store':              handleStore,
  '/search':             handleSearch,
  '/list':               handleList,
  '/read':               handleRead,
  '/read-with-requires': handleReadWithRequires,
  '/tag-index':          handleTagIndex,
  '/exists':             handleExists,
  '/update':             handleUpdate,
  '/reconstruct':        handleReconstruct, // async — returns Promise
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    let params = {};
    try { params = JSON.parse(body); } catch { /* empty body is fine */ }

    const handler = HANDLERS[req.url];
    let result;

    if (!handler) {
      result = `Unknown endpoint: ${req.url}\nAvailable: ${Object.keys(HANDLERS).join(', ')}`;
      log(`${req.method} ${req.url} → ${String(result).slice(0, 100).replace(/\n/g, ' ')}`);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(result);
    } else {
      Promise.resolve()
        .then(() => handler(params))
        .then(r => {
          result = r;
          log(`${req.method} ${req.url} → ${String(result).slice(0, 100).replace(/\n/g, ' ')}`);
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(result);
        })
        .catch(e => {
          result = 'Internal error: ' + e.message;
          log(`ERROR ${req.url}: ${e.message}`);
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(result);
        });
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`Memory server started on port ${PORT}`);
  log(`Storing memories at: ${MEMORY_ROOT}`);
});