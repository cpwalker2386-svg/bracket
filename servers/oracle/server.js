'use strict';

const http  = require('http');
const https = require('https');

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

// ─── Config ───────────────────────────────────────────────────────────────────

const apiKey = process.env.GEMINI_API_KEY;

// Free-tier models in preference order (vision-capable first, then fallbacks)
const GEMINI_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
];

const PORT = parseInt(process.env.PORT) || 2412;

// ─── Startup ──────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ─── Gemini HTTP helper ───────────────────────────────────────────────────────

/**
 * Send a request to the Gemini generateContent API.
 * @param {string} model  - Gemini model ID
 * @param {Array}  parts  - Array of Gemini content parts (text and/or inline_data)
 * @param {object} config - generationConfig overrides
 * @returns {Promise<{retry:bool, text?:string, reason?:string}>}
 */
function callGemini(model, parts, config = {}) {
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: {
      maxOutputTokens: 2048,
      temperature: 0.7,
      ...config,
    },
  });

  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  );

  return new Promise((resolve) => {
    const bodyBuf = Buffer.from(body, 'utf8');
    const req = https.request(
      {
        hostname: url.hostname,
        path:     url.pathname,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': bodyBuf.length,
          'x-goog-api-key': apiKey,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            log(`Gemini [${model}] status: ${res.statusCode}`);

            if (parsed.error) {
              const code = parsed.error.code;
              if (code === 503 || code === 429) {
                resolve({ retry: true, reason: `${code} — ${parsed.error.message}` });
              } else {
                resolve({ retry: false, text: `ERROR: Gemini API error ${code} — ${parsed.error.message}` });
              }
              return;
            }

            const text =
              parsed?.candidates?.[0]?.content?.parts?.[0]?.text;

            resolve({
              retry: false,
              text: (text && text.trim()) || 'ERROR: No text in Gemini response',
            });
          } catch (e) {
            resolve({ retry: false, text: `ERROR: Failed to parse Gemini response — ${e.message}` });
          }
        });
      }
    );

    req.on('error', (e) =>
      resolve({ retry: true, reason: `Network error — ${e.message}` })
    );
    req.write(bodyBuf);
    req.end();
  });
}

/**
 * Try each model in GEMINI_MODELS, returning the first successful response.
 */
async function geminiWithFallback(parts, config = {}, requireVision = false) {
  // If vision is required, filter to models that support it
  // (in practice all flash models support vision, but 8b is less capable)
  const models = requireVision
    ? GEMINI_MODELS.filter((m) => !m.includes('8b'))
    : GEMINI_MODELS;

  for (const model of models) {
    const result = await callGemini(model, parts, config);
    if (!result.retry) {
      if (!result.text.startsWith('ERROR')) {
        log(`Oracle: succeeded with ${model}`);
      }
      return result.text;
    }
    log(`Oracle: ${model} unavailable (${result.reason}), trying next…`);
  }
  return 'ERROR: All Gemini models unavailable or rate-limited';
}

// ─── Fetch image from URL and convert to base64 ───────────────────────────────

function fetchImageAsBase64(imageUrl) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(imageUrl);
    const transport = urlObj.protocol === 'https:' ? https : require('http');

    const req = transport.get(imageUrl, (res) => {
      // Follow redirects (up to 3 hops)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchImageAsBase64(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} fetching image`));
      }

      const mimeType = (res.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ data: buf.toString('base64'), mimeType });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error('Image fetch timed out'));
    });
  });
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * ASK — send a freeform message and get a response.
 * [(ASK {"message":"What is the meaning of life?"})]
 * Optional: "context" for system-level instruction, "temperature" (0.0–2.0)
 */
async function handleAsk(params) {
  const message = (params.message || params.msg || '').trim();
  if (!message) return 'ERROR: message is required';

  const context = (params.context || '').trim();
  const temperature = parseFloat(params.temperature) || 0.7;

  const systemNote = context
    ? `[Context: ${context}]\n\n`
    : '';

  const parts = [{ text: systemNote + message }];
  return await geminiWithFallback(parts, { temperature });
}

/**
 * SANITY — ask Gemini to sanity-check a claim, reasoning, or plan.
 * [(SANITY {"message":"I think the best way to sort is bubble sort for large arrays"})]
 * Returns a structured critique: VERDICT, ISSUES, SUGGESTION.
 */
async function handleSanity(params) {
  const message = (params.message || params.msg || '').trim();
  if (!message) return 'ERROR: message is required';

  const severity = (params.severity || 'balanced').trim(); // strict / balanced / gentle

  const severityNote = {
    strict:   'Be very critical and thorough. Challenge every assumption.',
    balanced: 'Be balanced. Note genuine issues without nitpicking.',
    gentle:   'Be constructive and encouraging. Focus only on major problems.',
  }[severity] || 'Be balanced.';

  const prompt = `You are a rigorous sanity-check assistant. ${severityNote}

The following claim, reasoning, or plan has been submitted for a sanity check:

"""
${message}
"""

Respond ONLY in this exact format:
VERDICT: <PASS | CONCERN | FAIL>
ISSUES:
- <issue 1, or "None" if passing cleanly>
- <issue 2 if applicable>
SUGGESTION: <one concrete improvement or "N/A" if none needed>`;

  const parts = [{ text: prompt }];
  const result = await geminiWithFallback(parts, { temperature: 0.2 });
  return `SANITY CHECK\n${'─'.repeat(40)}\n${result}`;
}

/**
 * SEE — fetch an image URL and ask Gemini to describe or analyze it.
 * [(SEE {"url":"https://example.com/image.jpg","prompt":"What is in this image?"})]
 * prompt is optional (defaults to a general description request).
 */
async function handleSee(params) {
  const imageUrl = (params.url || params.image || '').trim();
  if (!imageUrl) return 'ERROR: url is required';

  const userPrompt = (params.prompt || params.message || '').trim()
    || 'Describe this image in detail. Note all visible elements, text, colors, and context.';

  let imageData;
  try {
    imageData = await fetchImageAsBase64(imageUrl);
  } catch (err) {
    return `ERROR: Could not fetch image — ${err.message}`;
  }

  const parts = [
    { text: userPrompt },
    {
      inline_data: {
        mime_type: imageData.mimeType,
        data:      imageData.data,
      },
    },
  ];

  const result = await geminiWithFallback(parts, { temperature: 0.4 }, true /* requireVision */);
  return `IMAGE ANALYSIS\n${'─'.repeat(40)}\nURL: ${imageUrl}\nPrompt: ${userPrompt}\n${'─'.repeat(40)}\n${result}`;
}

/**
 * THINK — ask Gemini to reason through a problem step by step.
 * [(THINK {"message":"Should I use Redis or Postgres for session storage?"})]
 * Returns structured chain-of-thought reasoning.
 */
async function handleThink(params) {
  const message = (params.message || params.msg || '').trim();
  if (!message) return 'ERROR: message is required';

  const depth = (params.depth || 'normal').trim(); // quick / normal / deep

  const depthNote = {
    quick: 'Keep it concise — 3–5 bullet points max.',
    normal: 'Provide a thorough but focused analysis.',
    deep: 'Be exhaustive. Cover edge cases, trade-offs, and alternatives.',
  }[depth] || 'Provide a thorough but focused analysis.';

  const prompt = `You are a careful reasoning assistant. ${depthNote}

Think through the following step by step:

"""
${message}
"""

Format your response as:
ANALYSIS:
<your step-by-step reasoning>

CONCLUSION: <your final answer or recommendation in 1–2 sentences>`;

  const parts = [{ text: prompt }];
  const result = await geminiWithFallback(parts, { temperature: 0.4 });
  return `THINK\n${'─'.repeat(40)}\n${result}`;
}

/**
 * ORACLE_PING — check if the server and Gemini key are working.
 * [(ORACLE_PING)]
 */
async function handlePing() {
  const parts = [{ text: 'Reply with exactly: Oracle online' }];
  const result = await geminiWithFallback(parts, { temperature: 0, maxOutputTokens: 10 });
  const keyOk = !result.startsWith('ERROR');
  return keyOk
    ? `Oracle server: online\nGemini API: reachable\nResponse: ${result}`
    : `Oracle server: online\nGemini API: ${result}`;
}

// ─── Server ───────────────────────────────────────────────────────────────────

const HANDLERS = {
  '/ping':    handlePing,
  '/ask':     handleAsk,
  '/sanity':  handleSanity,
  '/see':     handleSee,
  '/think':   handleThink,
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let params = {};
    try { params = JSON.parse(body); } catch { /* empty body is fine */ }

    const handler = HANDLERS[req.url];

    if (!handler) {
      const msg = `Unknown endpoint: ${req.url}\nAvailable: ${Object.keys(HANDLERS).join(', ')}`;
      log(`${req.method} ${req.url} → unknown`);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(msg);
      return;
    }

    Promise.resolve()
      .then(() => handler(params))
      .then((result) => {
        log(`${req.method} ${req.url} → ${String(result).slice(0, 100).replace(/\n/g, ' ')}`);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(result);
      })
      .catch((e) => {
        const msg = `Internal error: ${e.message}`;
        log(`ERROR ${req.url}: ${e.message}`);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(msg);
      });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`Oracle server started on port ${PORT}`);
  log(`Using Gemini API key: ${apiKey.slice(0, 8)}…`);
  log(`Models: ${GEMINI_MODELS.join(', ')}`);
});
