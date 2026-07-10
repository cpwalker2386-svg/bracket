'use strict';

/**
 * Browse server — port 2410
 *
 * Commands:
 *   BROWSE   { query }         — DuckDuckGo search → titles, snippets, URLs
 *   OPENURL  { url }           — Fetch a URL → clean extracted article text
 *
 * Dependencies (install once in the browse directory):
 *   npm install @mozilla/readability jsdom
 */

const http    = require('http');
const https   = require('https');
const { Readability } = require('@mozilla/readability');
const { JSDOM }       = require('jsdom');

const PORT = parseInt(process.env.PORT) || 2410;

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ─── Shared fetch helper ──────────────────────────────────────────────────────

function fetchURL(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        ...extraHeaders,
      },
      timeout: 15000,
    };

    const req = mod.request(options, (res) => {
      // Follow redirects (up to 5)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = new URL(res.headers.location, url).href;
        return fetchURL(next, extraHeaders)
          .then(resolve)
          .catch(reject);
      }

      if (res.statusCode < 200 || res.statusCode >= 400) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        contentType: res.headers['content-type'] || '',
        status: res.statusCode,
      }));
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    req.end();
  });
}

// ─── BROWSE — DuckDuckGo search ───────────────────────────────────────────────

async function handleBrowse(params) {
  const query = params.query || params.q || params.search;
  if (!query) return 'ERROR: query is required. Usage: [(BROWSE {"query":"your search"})]';

  const encoded = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`;

  let res;
  try {
    res = await fetchURL(url, {
      'Referer': 'https://duckduckgo.com/',
    });
  } catch (err) {
    return `ERROR fetching search results: ${err.message}`;
  }

  // Parse results from DDG HTML
  const dom  = new JSDOM(res.body);
  const doc  = dom.window.document;
  const hits = doc.querySelectorAll('.result');

  if (!hits.length) {
    return `No results found for: ${query}`;
  }

  const results = [];
  let count = 0;

  for (const hit of hits) {
    if (count >= 8) break;

    const titleEl   = hit.querySelector('.result__title a, .result__a');
    const snippetEl = hit.querySelector('.result__snippet');
    const urlEl     = hit.querySelector('.result__url, .result__extras__url');

    const title   = titleEl?.textContent?.trim();
    const snippet = snippetEl?.textContent?.trim();

    // DDG wraps real URLs in a redirect — pull the actual href
    let href = titleEl?.getAttribute('href') || '';
    if (href.startsWith('//duckduckgo.com/l/?')) {
      try {
        const uddg = new URL('https:' + href).searchParams.get('uddg');
        if (uddg) href = decodeURIComponent(uddg);
      } catch (_) {}
    }

    if (!title || !href || href.startsWith('javascript')) continue;

    results.push({ title, snippet, url: href });
    count++;
  }

  if (!results.length) {
    return `No usable results found for: ${query}`;
  }

  const lines = [`Search: ${query}`, ''];
  results.forEach((r, i) => {
    lines.push(`[${i + 1}] ${r.title}`);
    if (r.snippet) lines.push(`    ${r.snippet}`);
    lines.push(`    ${r.url}`);
    lines.push('');
  });

  lines.push('Use [(OPENURL {"url":"..."})] to read a result.');
  return lines.join('\n');
}

// ─── OPENURL — fetch and extract a specific URL ───────────────────────────────

async function handleOpenURL(params) {
  const url = params.url || params.href || params.link;
  if (!url) return 'ERROR: url is required. Usage: [(OPENURL {"url":"https://example.com"})]';

  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return `ERROR: Invalid URL: ${url}`;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return 'ERROR: Only http/https URLs are supported.';
  }

  let res;
  try {
    res = await fetchURL(url);
  } catch (err) {
    return `ERROR: ${err.message} — ${url}`;
  }

  // Non-HTML response — return raw truncated text
  if (!res.contentType.includes('html')) {
    const MAX = 3000;
    const text = res.body.slice(0, MAX);
    return `URL: ${url}\nContent-Type: ${res.contentType}\n\n${text}${res.body.length > MAX ? `\n\n[… truncated]` : ''}`;
  }

  // Parse with Readability for clean article extraction
  let article = null;
  try {
    const dom = new JSDOM(res.body, { url });
    const reader = new Readability(dom.window.document, {
      charThreshold: 20,
      keepClasses: false,
    });
    article = reader.parse();
  } catch (err) {
    return `ERROR parsing page: ${err.message}`;
  }

  if (!article || !article.textContent?.trim()) {
    // Fallback: basic tag strip
    const plain = res.body
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{3,}/g, '\n\n')
      .trim();

    const MAX = 4000;
    return `URL: ${url}\n[Readability could not extract article — raw text below]\n\n${plain.slice(0, MAX)}${plain.length > MAX ? '\n\n[… truncated]' : ''}`;
  }

  // Clean up extracted text
  const text = article.textContent
    .replace(/\t/g, ' ')
    .replace(/ {3,}/g, '  ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

  const MAX = 5000;
  const truncated = text.length > MAX
    ? text.slice(0, MAX) + `\n\n[… ${text.length - MAX} more chars — article continues]`
    : text;

  const header = [
    `URL: ${url}`,
    article.title ? `Title: ${article.title}` : null,
    article.byline ? `By: ${article.byline}` : null,
    article.siteName ? `Site: ${article.siteName}` : null,
    '',
  ].filter(l => l !== null).join('\n');

  return header + truncated;
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
      case '/browse':  result = await handleBrowse(params);  break;
      case '/openurl': result = await handleOpenURL(params); break;
      default:
        res.writeHead(404);
        res.end('Unknown route: ' + req.url + '. Available: /browse, /openurl');
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
  log(`Browse server running on port ${PORT}`);
  log('BROWSE   {"query":"..."}  — DuckDuckGo search');
  log('OPENURL  {"url":"..."}    — fetch and extract a page');
});
