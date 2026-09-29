#!/usr/bin/env node
// Deployable-search check: our policy plays a simulated game seeing only its own view/request; the ladder searcher (reconstruction + rollouts)
// may override its choice. Compared against the same policy without search on the same seeds/teams. Opponent: 'human' | 'guarded' | 'heuristic'.
//   node scripts/ladder-search-eval.mjs --policy p.json --team t.json --opp-teams a.json,b.json [--opp human] [--games 40] [--jobs 4] [--det 4] [--rollouts 3]
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import showdown from 'pokemon-showdown';
import {Policy} from '../dist/src/champions-worker.js';
import {DirectGame} from '../dist/src/direct-battle.js';
import {act} from '../dist/src/search.js';
import {makeLadderSearch, DEFAULT_LADDER_SEARCH} from '../dist/src/ladder-search.js';

const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : f; };
const games = Number(opt('--games', 40)), jobs = Number(opt('--jobs', 4)), oppKind = opt('--opp', 'human');
const cfg = {...DEFAULT_LADDER_SEARCH, determinizations: Number(opt('--det', 4)), rollouts: Number(opt('--rollouts', 3))};
const own = JSON.parse(readFileSync(opt('--team'), 'utf8')).pack;
const oppPacks = opt('--opp-teams', '').split(',').filter(Boolean).map(p => JSON.parse(readFileSync(p, 'utf8')).pack);
const prng = n => { const r = new showdown.PRNG(`41,53,${(n >>> 16) & 65535},${n & 65535}`); return () => r.random(); };
const worker = process.env.LSE_WORKER ? JSON.parse(process.env.LSE_WORKER) : null;

function play(policy, seed, useSearch) {
  const foePack = oppPacks[seed % oppPacks.length], ourSide = seed % 2 ? 'p1' : 'p2', foeSide = ourSide === 'p1' ? 'p2' : 'p1';
  const rng = {p1: prng(seed * 2), p2: prng(seed * 2 + 1)};
  const game = DirectGame.create(ourSide === 'p1' ? [own, foePack] : [foePack, own], [7, 9, seed >>> 16 & 65535, seed & 65535]);
  const searcher = useSearch ? makeLadderSearch(policy, own, cfg, prng(seed * 5 + 3)) : null;
  let searchMs = 0, decisions = 0, overridden = 0;
  const t0 = Date.now();
  // Team preview: both sides bring the first four (same for search / no-search so the comparison is paired).
  // Team preview: the policy picks its own four (as on the ladder); the opponent brings its first four.
  { const enc = game.encodeFor(ourSide), pick = policy.choose(enc, rng[ourSide], undefined, undefined); game.hidden[ourSide] = pick.nextHidden; game.choose(ourSide, enc.candidates[pick.action].choice); game.choose(foeSide, 'team 1234'); }
  let guard = 0;
  while (!game.ended && guard++ < 200) {
    for (const side of game.pending()) {
      if (side === foeSide) { act(game, foeSide, oppKind, rng[side]); continue; }
      const encoded = game.encodeFor(side), request = game.requests[side];
      const before = game.hidden[side];
      const pick = policy.choose(encoded, rng[side], undefined, before);
      let action = pick.action;
      if (searcher && !request.forceSwitch) {
        const t = performance.now(); const found = searcher(encoded, request, game.views[side], before); searchMs += performance.now() - t;
        decisions++; if (found) { overridden += found.action !== action; action = found.action; }
      }
      if (pick.nextHidden) game.hidden[side] = pick.nextHidden;
      if (!game.choose(side, encoded.candidates[action].choice)) act(game, side, policy, rng[side]);
    }
  }
  return {seed, win: game.winner === ourSide ? 1 : game.winner ? 0 : 0.5, searchMs, decisions, overridden};
}

if (worker) {
  const policy = new Policy(JSON.parse(readFileSync(worker.policy, 'utf8')));
  const rows = worker.seeds.flatMap(seed => [{mode: 'plain', ...play(policy, seed, false)}, {mode: 'search', ...play(policy, seed, true)}]);
  writeFileSync(worker.out, JSON.stringify(rows)); process.exit(0);
}
const policyPath = opt('--policy'), base = Number(opt('--seed-base', 9300000000));
const dir = mkdtempSync(join(tmpdir(), 'lse-'));
const seeds = Array.from({length: games}, (_, i) => base + i);
const started = Date.now();
await Promise.all(Array.from({length: jobs}, (_, k) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {env: {...process.env, LSE_WORKER: JSON.stringify({policy: policyPath, seeds: seeds.filter((_, i) => i % jobs === k), out: join(dir, `${k}.json`)})}, stdio: 'inherit'});
  p.on('exit', c => c === 0 ? resolve() : reject(new Error(`worker ${k} exit ${c}`)));
})));
const rows = Array.from({length: jobs}, (_, k) => JSON.parse(readFileSync(join(dir, `${k}.json`), 'utf8'))).flat();
rmSync(dir, {recursive: true, force: true});
const avg = xs => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const plain = rows.filter(r => r.mode === 'plain'), search = rows.filter(r => r.mode === 'search');
const bySeed = new Map(plain.map(r => [r.seed, r.win])); const diffs = search.map(r => r.win - bySeed.get(r.seed));
const mean = avg(diffs), sd = Math.sqrt(avg(diffs.map(d => (d - mean) ** 2)) * diffs.length / Math.max(1, diffs.length - 1));
console.log(JSON.stringify({games, opp: oppKind, config: cfg, plain: +avg(plain.map(r => r.win)).toFixed(3), search: +avg(search.map(r => r.win)).toFixed(3),
  pairedDiff: +mean.toFixed(3), ci95: [+(mean - 1.96 * sd / Math.sqrt(diffs.length)).toFixed(3), +(mean + 1.96 * sd / Math.sqrt(diffs.length)).toFixed(3)],
  msPerSearchedDecision: +(avg(search.map(r => r.searchMs)) / Math.max(1, avg(search.map(r => r.decisions)))).toFixed(0),
  overrideRate: +(search.reduce((a, r) => a + r.overridden, 0) / Math.max(1, search.reduce((a, r) => a + r.decisions, 0))).toFixed(3), seconds: Math.round((Date.now() - started) / 1000)}));
