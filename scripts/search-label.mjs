#!/usr/bin/env node
// Expert-iteration data: play games with the learner policy on its team; at every battle decision run rollout search and record the
// search-improved target distribution over the searched candidate subset. The game is steered by the search half of the time so the
// dataset also covers states a search-improved player reaches. Rollouts model both sides with the learner's own policy (no peeking at
// the real opponent's behaviour); the cloned battle does contain the opponent's true hidden sets (privileged teacher).
//   node scripts/search-label.mjs --policy p.json --team t.json --opp-teams a.json,b.json --out labels.jsonl [--opps heuristic,champion.json]
//        [--games 200] [--jobs 5] [--rollouts 6] [--top 10] [--switch 4] [--random 2] [--tau 0.15] [--follow 0.5] [--seed-base 9500000000]
import {spawn} from 'node:child_process';
import {appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import showdown from 'pokemon-showdown';
import {Policy} from '../dist/src/champions-worker.js';
import {DirectGame} from '../dist/src/direct-battle.js';
import {act, searchDecision} from '../dist/src/search.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const list = value => (value ?? '').split(',').filter(Boolean);
const games = Number(opt('--games', 200)), jobs = Number(opt('--jobs', 5)), seedBase = Number(opt('--seed-base', 9500000000));
const config = {topK: Number(opt('--top', 10)), switchK: Number(opt('--switch', 4)), randomK: Number(opt('--random', 2)), rollouts: Number(opt('--rollouts', 6)), maxTurns: 14};
const tau = Number(opt('--tau', 0.15)), follow = Number(opt('--follow', 0.5));
const learnerPack = JSON.parse(readFileSync(opt('--team'), 'utf8')).pack;
const oppPacks = list(opt('--opp-teams')).map(path => JSON.parse(readFileSync(path, 'utf8')).pack);
const out = opt('--out');
const prng = n => { const rng = new showdown.PRNG(`41,53,${(n >>> 16) & 65535},${n & 65535}`); return () => rng.random(); };
const worker = process.env.LABEL_WORKER ? JSON.parse(process.env.LABEL_WORKER) : null;
const round = x => Math.round(x * 1e4) / 1e4;

function playGame(policy, oppAgents, seed) {
  const learner = seed % 2 ? 'p1' : 'p2', foe = learner === 'p1' ? 'p2' : 'p1';
  const oppPack = oppPacks[(Math.imul(seed | 0, 2654435761) >>> 0) % oppPacks.length];
  const oppAgent = oppAgents[(Math.imul(seed | 0, 2246822519) >>> 0) % oppAgents.length];
  const game = DirectGame.create(learner === 'p1' ? [learnerPack, oppPack] : [oppPack, learnerPack], [17, 29, (seed >>> 16) & 65535, seed & 65535]);
  const realAgents = {[learner]: policy, [foe]: oppAgent}, modelAgents = {p1: policy, p2: policy};
  const random = prng(seed * 3 + 1);
  const steps = [];
  let guard = 0;
  while (!game.ended && guard++ < 300) {
    for (const side of game.pending()) {
      const request = game.requests[side];
      if (side === learner && request?.active) {
        const result = searchDecision(game, side, modelAgents, random, config);
        const top = Math.max(...result.q), exps = result.q.map(q => Math.exp((q - top) / tau)), total = exps.reduce((a, b) => a + b, 0);
        const target = exps.map(e => e / total);
        const encoded = result.encoded;
        steps.push({state: encoded.state.map(round), actions: encoded.candidates.map(c => c.features.map(round)), simple: encoded.candidates.map(c => round(c.simpleScore)),
          subset: result.subset, target: target.map(round), q: result.q.map(round), forced: Boolean(request.forceSwitch)});
        const nextHidden = policy.predict(encoded, undefined, game.hidden[side]).hidden;
        if (random() < follow) {                         // follow the search-improved choice
          let draw = random(), pick = 0;
          for (let i = 0; i < target.length; i++) { draw -= target[i]; if (draw <= 0) { pick = i; break; } }
          if (game.choose(side, encoded.candidates[result.subset[pick]].choice)) { game.hidden[side] = nextHidden; continue; }
        }
        act(game, side, realAgents[side], random);
      } else {
        // Non-searched learner decisions (team preview, forced replacements) are still recorded, with no target, so a recurrent
        // student sees the same decision sequence as the real game.
        if (side === learner) {
          const encoded = game.encodeFor(side);
          steps.push({state: encoded.state.map(round), actions: encoded.candidates.map(c => c.features.map(round)), simple: encoded.candidates.map(c => round(c.simpleScore)),
            subset: [], target: [], q: [], forced: Boolean(request?.forceSwitch), preview: Boolean(request?.teamPreview)});
        }
        act(game, side, realAgents[side], random);
      }
    }
  }
  return {seed, learner, win: game.winner === learner ? 1 : game.winner ? 0 : 0.5, steps};
}
const loadAgents = () => ({policy: new Policy(JSON.parse(readFileSync(opt('--policy'), 'utf8'))),
  opps: list(opt('--opps', 'heuristic')).map(item => item === 'heuristic' ? 'heuristic' : new Policy(JSON.parse(readFileSync(item, 'utf8'))))});

if (worker) {
  const {policy, opps} = loadAgents();
  for (const seed of worker.seeds) appendFileSync(worker.out, JSON.stringify(playGame(policy, opps, seed)) + '\n');
  process.exit(0);
}
const dir = mkdtempSync(join(tmpdir(), 'search-label-'));
const seeds = Array.from({length: games}, (_, i) => seedBase + i);
const started = Date.now();
writeFileSync(out, '');
await Promise.all(Array.from({length: jobs}, (_, k) => new Promise((resolve, reject) => {
  const file = join(dir, `${k}.jsonl`);
  const proc = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {env: {...process.env,
    LABEL_WORKER: JSON.stringify({seeds: seeds.filter((_, i) => i % jobs === k), out: file})}, stdio: 'ignore'});
  proc.on('exit', code => { if (code !== 0) return reject(new Error(`label worker ${k} failed (${code})`)); appendFileSync(out, readFileSync(file)); resolve(); });
})));
rmSync(dir, {recursive: true, force: true});
const rows = readFileSync(out, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const steps = rows.reduce((n, r) => n + r.steps.filter(x => x.subset.length).length, 0);
const switchTop = rows.flatMap(r => r.steps).filter(s => s.subset.length && !s.forced).map(s => { const best = s.q.indexOf(Math.max(...s.q)); return Number(s.actions[s.subset[best]][1] > 0.5 || s.actions[s.subset[best]][25] > 0.5); });
console.log(JSON.stringify({games: rows.length, decisions: steps, seconds: +((Date.now() - started) / 1000).toFixed(0), winRate: +(rows.reduce((s, r) => s + r.win, 0) / rows.length).toFixed(3),
  searchBestIsVoluntarySwitch: +(switchTop.reduce((a, b) => a + b, 0) / Math.max(1, switchTop.length)).toFixed(3), fileMB: +(readFileSync(out).length / 1e6).toFixed(1)}));
