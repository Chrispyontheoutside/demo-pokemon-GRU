import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Arena, ArenaInputError } from './arena.js';
import { ArenaStore } from './store.js';
import { loadAgents } from './config.js';
import type { Mode } from './contracts.js';
import {HumanBattle} from './play.js';
import {Policy} from './gen6.js';

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Use application/json.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 16_384) throw new HttpError(413, 'Request body is too large.');
    chunks.push(Buffer.from(chunk));
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object.');
  return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, field: string): string {
  if (typeof body[field] !== 'string') throw new HttpError(400, `Missing ${field}.`);
  return body[field] as string;
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

export function createArenaServer(arena: Arena, root: string) {
  const humanBattles = new Map<string, HumanBattle>();
  const checkpointPath = resolve(root, 'models/gen6-policy.json');
  const cleanup = setInterval(() => {
    for (const [id, battle] of humanBattles) if (Date.now() - battle.touchedAt > 30 * 60_000) {
      battle.forfeit(); humanBattles.delete(id);
    }
  }, 60_000);
  cleanup.unref();
  const clients = new Set<ServerResponse>();
  let eventId = 0;
  const event = (type: string, data: unknown) => {
    const chunk = `id: ${++eventId}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      if (client.writableLength > 1_048_576) { client.destroy(); clients.delete(client); }
      else client.write(chunk);
    }
  };
  const onState = (state: unknown) => event('state', state);
  const onMatch = (message: unknown) => event('match', message);
  const onFinished = (message: unknown) => event('finished', message);
  arena.on('state', onState); arena.on('match', onMatch); arena.on('finished', onFinished);

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // Only local renderer files execute; remote hosts supply image/audio assets.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://play.pokemonshowdown.com https://raw.githubusercontent.com; media-src 'self' https://play.pokemonshowdown.com; font-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
    try {
      const port = (server.address() as { port: number } | null)?.port;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!req.headers.host || !allowedHosts.includes(req.headers.host)) throw new HttpError(403, 'Use the local arena address.');
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new HttpError(403, 'Cross-origin requests are not allowed.');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site requests are not allowed.');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const path = decodeURIComponent(url.pathname);
      if (path === '/api/play' && req.method === 'GET') {
        if (!existsSync(checkpointPath)) return send(res, 200, {ready: false});
        const {steps, games, algorithm} = new Policy(JSON.parse(readFileSync(checkpointPath, 'utf8'))).checkpoint;
        return send(res, 200, {ready: steps > 0, steps, games, algorithm});
      }
      if (path === '/api/play' && req.method === 'POST') {
        await jsonBody(req);
        if (!existsSync(checkpointPath)) throw new HttpError(409, 'The learner checkpoint is not ready.');
        if (humanBattles.size >= 8) {
          const finished = [...humanBattles.values()].find(b => b.status !== 'playing');
          if (finished) humanBattles.delete(finished.id);
          else throw new HttpError(409, 'Finish an existing battle before starting another.');
        }
        const battle = new HumanBattle(checkpointPath);
        humanBattles.set(battle.id, battle);
        return send(res, 201, battle.snapshot());
      }
      const playRoute = path.match(/^\/api\/play\/([a-z0-9-]+)(?:\/(action|forfeit|replay))?$/);
      if (playRoute) {
        const battle = humanBattles.get(playRoute[1]);
        if (!battle) throw new HttpError(404, 'Battle not found. Start a new game.');
        battle.touchedAt = Date.now();
        if (req.method === 'GET' && !playRoute[2]) return send(res, 200, battle.snapshot());
        if (req.method === 'GET' && playRoute[2] === 'replay') {
          res.writeHead(200, {'Content-Type':'text/plain; charset=utf-8', 'Content-Disposition':`attachment; filename="gen6-${battle.id}.log"`});
          return res.end(battle.lines.join('\n'));
        }
        if (req.method === 'POST') {
          const body = await jsonBody(req);
          if (playRoute[2] === 'forfeit') battle.forfeit();
          else if (playRoute[2] === 'action') {
            try { battle.choose(body.requestId, body.action); }
            catch (error) { throw new HttpError(409, (error as Error).message); }
          } else throw new HttpError(404, 'Action not found.');
          return send(res, 200, battle.snapshot());
        }
      }
      if (path === '/api/state' && req.method === 'GET') return send(res, 200, arena.state());
      if (path === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        clients.add(res);
        res.write(`event: state\ndata: ${JSON.stringify(arena.state())}\n\n`);
        const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
        req.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
        return;
      }
      if (path === '/api/queue' && req.method === 'POST') {
        const body = await jsonBody(req);
        arena.enqueue(stringField(body, 'agentId'), stringField(body, 'mode') as Mode);
        return send(res, 200, arena.state());
      }
      const queue = path.match(/^\/api\/queue\/([a-z0-9_-]+)$/);
      if (queue && req.method === 'DELETE') { arena.dequeue(queue[1]); return send(res, 200, arena.state()); }
      if (path === '/api/evaluations' && req.method === 'POST') {
        const body = await jsonBody(req);
        return send(res, 201, { id: arena.evaluate(stringField(body, 'p1Id'), stringField(body, 'p2Id')) });
      }
      const matchRoute = path.match(/^\/api\/matches\/([a-zA-Z0-9-]+)(?:\/(cancel|replay|audit))?$/);
      if (matchRoute) {
        const [, id, action] = matchRoute;
        const match = arena.store.getMatch(id);
        if (!match) throw new HttpError(404, 'Match not found.');
        if (action === 'cancel' && req.method === 'POST') {
          await jsonBody(req); arena.cancel(id); return send(res, 200, { ok: true });
        }
        if (req.method === 'GET' && !action) return send(res, 200, arena.detail(id));
        if (req.method === 'GET' && action === 'replay') {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${id}.log"`, 'Cache-Control': 'no-store' });
          return res.end(arena.store.getRecords(id).filter(r => r.kind === 'public').map(r => r.data).join('\n') + '\n');
        }
        if (req.method === 'GET' && action === 'audit') {
          if (!arena.auditAvailable(id)) throw new HttpError(409, 'Audit unlocks when the match and its evaluation have ended.');
          res.setHeader('Content-Disposition', `attachment; filename="${id}.audit.json"`);
          return send(res, 200, { match, metadata: arena.store.getPrivate(id), records: arena.store.getRecords(id) });
        }
      }
      if (path.startsWith('/api/')) throw new HttpError(404, 'API route not found.');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      const publicRoot = resolve(root, 'public');
      const file = path === '/app.js' ? resolve(root, 'dist/web/app.js') : resolve(publicRoot, `.${path === '/' ? '/index.html' : path}`);
      if (path !== '/app.js' && !file.startsWith(publicRoot + sep)) throw new HttpError(404, 'File not found.');
      const extensions: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg' };
      let bytes: Buffer;
      try { bytes = readFileSync(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'EISDIR') throw new HttpError(404, 'File not found.');
        throw error;
      }
      res.writeHead(200, { 'Content-Type': `${extensions[extname(file)] ?? 'application/octet-stream'}${/\.(?:html|js|css|json)$/.test(file) ? '; charset=utf-8' : ''}`, 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof HttpError ? error.status : error instanceof ArenaInputError || error instanceof URIError ? 400 : 500;
      if (status === 500) console.error('Arena request failed:', error);
      send(res, status, { error: status === 500 ? 'The arena could not complete this request.' : error instanceof Error ? error.message : 'Request failed.' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on('close', () => {
    clearInterval(cleanup);
    for (const battle of humanBattles.values()) battle.forfeit();
    arena.off('state', onState); arena.off('match', onMatch); arena.off('finished', onFinished);
    for (const client of clients) client.end();
  });
  return { server, closeClients: () => { for (const client of clients) client.end(); clients.clear(); } };
}

async function main() {
  const root = process.cwd();
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.');
  const dataDir = resolve(root, process.env.ARENA_DATA_DIR ?? 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = new ArenaStore(resolve(dataDir, 'arena.sqlite'));
  const arena = new Arena(store, loadAgents(resolve(root, process.env.ARENA_AGENTS_FILE ?? 'agents.json'), root));
  const { server, closeClients } = createArenaServer(arena, root);
  arena.on('arena-error', error => console.error('Arena scheduler failed:', error));
  server.listen(port, '127.0.0.1', () => {
    console.log(`Showdown Arena is ready at http://127.0.0.1:${port}`);
    if (!existsSync(resolve(root, 'public/vendor/manifest.json'))) console.log('If the viewer needs setup, run npm run setup:viewer.');
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    closeClients();
    server.close();
    await arena.stop();
    store.close();
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
