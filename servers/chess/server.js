'use strict';
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { Chess } = require('chess.js');
const PORT = process.env.CHESS_PORT || 2409;
const STOCKFISH_PATH = path.resolve(__dirname, 'node_modules/stockfish/src/stockfish-nnue-16.js');

// ─── Game State ───────────────────────────────────────────────────────────────

let game = new Chess();
let moveHistory = [];
let searchDepth = 15;
function resetGame(fen) {
  game = fen ? new Chess(fen) : new Chess();
  moveHistory = [];
}

// ─── Stockfish Engine ─────────────────────────────────────────────────────────

function createEngine() {
  const proc = spawn('node', [STOCKFISH_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
  const listeners = [];
  let buffer = '';
  let spawnError = null;

  proc.on('error', (err) => { spawnError = err; });

  proc.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (t) listeners.forEach(fn => fn(t));
    }
  });
  proc.stderr.on('data', () => {});

  const send = (cmd) => proc.stdin.write(cmd + '\n');

  const waitFor = (predicate, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const collected = [];
      const tid = setTimeout(() => {
        remove();
        if (spawnError) reject(new Error(`Engine failed to start: ${spawnError.message}`));
        else reject(new Error('Engine timeout'));
      }, timeoutMs);
      const handler = (line) => {
        collected.push(line);
        if (predicate(line, collected)) { clearTimeout(tid); remove(); resolve(collected); }
      };
      listeners.push(handler);
      function remove() {
        const i = listeners.indexOf(handler);
        if (i !== -1) listeners.splice(i, 1);
      }
    });

  const quit = () => { try { send('quit'); } catch (_) {} };

  return { send, waitFor, quit };
}

function parseScore(infoLines) {
  for (const line of [...infoLines].reverse()) {
    const mateMatch = line.match(/score mate (-?\d+)/);
    if (mateMatch) {
      const m = parseInt(mateMatch[1]);
      return { cp: m > 0 ? 100000 : -100000, mate: m };
    }
    const cpMatch = line.match(/score cp (-?\d+)/);
    if (cpMatch) return { cp: parseInt(cpMatch[1]), mate: null };
  }
  return { cp: 0, mate: null };
}

async function evalMove(engine, fen, uciMove, depth) {
  engine.send(`position fen ${fen}`);
  engine.send(`go depth ${depth} searchmoves ${uciMove}`);
  const lines = await engine.waitFor(l => l.startsWith('bestmove'), 20000);
  const infoLines = lines.filter(l => l.startsWith('info') && l.includes('score'));
  return parseScore(infoLines);
}

async function getRecommendations() {
  const fen = game.fen();
  const legalMoves = game.moves({ verbose: true });
  if (legalMoves.length === 0) {
    if (game.isCheckmate()) return 'Checkmate.';
    return 'Game over (draw/stalemate).';
  }
  const engine = createEngine();
  engine.send('uci');
  await engine.waitFor(l => l === 'uciok');
  engine.send('isready');
  await engine.waitFor(l => l === 'readyok');
  const results = [];
  for (const mv of legalMoves) {
    const uci = mv.from + mv.to + (mv.promotion || '');
    const { cp, mate } = await evalMove(engine, fen, uci, searchDepth);
    results.push({ san: mv.san, uci, cp, mate });
  }
  engine.quit();

  // Note: mate<0 (forced mate AGAINST the player) is intentionally excluded
  // from this table by design — RECOMMENDATION never surfaces absolute loss
  // lines, even in theory. This is a deliberate product decision, not a bug.
  const mateMoves = results.filter(r => r.mate !== null && r.mate > 0);
  mateMoves.sort((a, b) => a.mate - b.mate); // fastest mate first
  const regularMoves = results.filter(r => r.mate === null);
  regularMoves.sort((a, b) => b.cp - a.cp);
  const bestCp = regularMoves.length > 0 ? regularMoves[0].cp : 0;
  const BLUNDER_THRESHOLD = -500;
  const filteredRegular = regularMoves.filter(r => r.cp - bestCp >= BLUNDER_THRESHOLD);
  const filtered = [...mateMoves, ...filteredRegular];
  const lines = [
    `Depth: ${searchDepth} | Position: ${fen}`,
    `Legal: ${legalMoves.length} total, ${filtered.length} shown (${legalMoves.length - filtered.length} blunders pruned)`,
    '',
    'Move     UCI      Score        Label',
    '─────────────────────────────────────',
  ];
  for (const r of filtered) {
    const delta = r.mate !== null ? 0 : r.cp - bestCp;
    const scoreStr = r.mate !== null
      ? (r.mate > 0 ? `Mate in ${r.mate}` : `Mated in ${Math.abs(r.mate)}`)
      : `${r.cp > 0 ? '+' : ''}${r.cp} cp`;
    const label = delta === 0 ? 'Best'
      : delta >= -30  ? 'Excellent'
      : delta >= -80  ? 'Good'
      : delta >= -150 ? 'Inaccuracy'
      : 'Mistake';
    lines.push(`${r.san.padEnd(9)}${r.uci.padEnd(9)}${scoreStr.padEnd(13)}${label}`);
  }
  return lines.join('\n');
}

// ─── Command Handlers ─────────────────────────────────────────────────────────

function drawReason() {
  if (game.isStalemate()) return 'stalemate';
  if (game.isThreefoldRepetition()) return 'threefold repetition';
  if (game.isInsufficientMaterial()) return 'insufficient material';
  if (typeof game.isDrawByFiftyMoves === 'function' && game.isDrawByFiftyMoves()) return '50-move rule';
  return 'draw';
}

function resultTag() {
  if (game.isCheckmate()) return game.turn() === 'w' ? '0-1' : '1-0';
  if (game.isDraw()) return '1/2-1/2';
  return '*';
}

function handleList() {
  if (moveHistory.length === 0) return 'No moves played yet.';
  const pairs = [];
  for (let i = 0; i < moveHistory.length; i += 2) {
    const n = Math.floor(i / 2) + 1;
    const w = moveHistory[i];
    const b = moveHistory[i + 1] || '';
    pairs.push(`${n}. ${w}${b ? '  ' + b : ''}`);
  }
  return pairs.join('\n') + `\n\nResult: ${resultTag()}`;
}

function handleBoard() {
  const ascii = game.ascii();
  const fen = game.fen();
  const turn = game.turn() === 'w' ? 'White' : 'Black';
  return `${ascii}\n\nFEN: ${fen}\nTurn: ${turn}`;
}

function handleMoves() {
  const moves = game.moves();
  if (moves.length === 0) return 'No legal moves — game over.';
  const turn = game.turn() === 'w' ? 'White' : 'Black';
  const grouped = [];
  for (let i = 0; i < moves.length; i += 8) {
    grouped.push(moves.slice(i, i + 8).join('  '));
  }
  return `Turn: ${turn} | ${moves.length} legal moves\n\n${grouped.join('\n')}`;
}

function handleDepth(params) {
  const level = parseInt(params.level);
  if (isNaN(level) || level < 1 || level > 30) {
    return 'Invalid depth. Use a number between 1 and 30.';
  }
  searchDepth = level;
  return `Search depth set to ${searchDepth}.`;
}

function handleMove(params) {
  const san = params.san || params.move || params.uci;
  if (!san) return 'No move provided. Use {"san":"e4"} or {"uci":"e2e4"}.';

  let result;
  try {
    result = game.move(san);
  } catch (e) {
    result = null;
  }

  if (!result && /^[a-h][1-8][a-h][1-8]([qrbn])?$/.test(san)) {
    const from = san.slice(0, 2), to = san.slice(2, 4), promo = san[4];
    const piece = game.get(from);
    const isPromotion = piece && piece.type === 'p' && (to[1] === '8' || to[1] === '1');
    if (isPromotion && !promo) {
      return `Promotion required for ${from}${to}. Specify piece: e.g. "${from}${to}q" (Q), "${from}${to}n" (N), "${from}${to}r" (R), "${from}${to}b" (B).`;
    }
    try {
      result = game.move({ from, to, promotion: promo || undefined });
    } catch (_) {}
  }

  if (!result) return `Illegal move: "${san}". Use SAN (e.g. "e4", "Nf3", "e8=N") or UCI (e.g. "e2e4", "e7e8n").`;

  moveHistory.push(result.san);

  const status = game.isCheckmate() ? ' Checkmate!'
    : game.isCheck() ? ' Check!'
    : game.isDraw() ? ` Draw (${drawReason()}).`
    : '';

  return `Move played: ${result.san}${status}\nFEN: ${game.fen()}`;
}

function handleUndo() {
  const undone = game.undo();
  if (!undone) return 'Nothing to undo.';
  moveHistory.pop();
  return `Undid: ${undone.san}\nFEN: ${game.fen()}`;
}

function handleReset(params) {
  const fen = params && params.fen;
  if (fen) {
    try {
      resetGame(fen);
    } catch (e) {
      return `Invalid FEN: "${fen}". ${e.message}`;
    }
    return `Board loaded from FEN.\nFEN: ${game.fen()}`;
  }
  resetGame();
  return 'Board reset. New game started.';
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

  // Health check
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('pong');
    return;
  }

  const params = await readBody(req);
  let result = '';

  try {
    switch (req.url) {
      case '/list':           result = handleList();          break;
      case '/board':          result = handleBoard();         break;
      case '/moves':          result = handleMoves();         break;
      case '/depth':          result = handleDepth(params);   break;
      case '/move':           result = handleMove(params);    break;
      case '/undo':            result = handleUndo();          break;
      case '/reset':           result = handleReset(params);   break;
      case '/recommendation':
        result = await getRecommendations();
        break;
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

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(result);
});

server.listen(PORT, () => {
  console.log(`Chess server running on http://localhost:${PORT}`);
  console.log(`Stockfish path: ${STOCKFISH_PATH}`);
  console.log(`Depth: ${searchDepth}`);
});