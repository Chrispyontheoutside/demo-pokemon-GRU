#!/usr/bin/env node
// Paired local evaluation: the same policy on the same team/seeds played (a) as-is and (b) with rollout search at every battle decision.
//   node scripts/search-eval.mjs --policy p.json --team t.json --opp-teams a.json,b.json [--opp heuristic|policy.json] [--games 60]
//        [--rollouts 4] [--top 8] [--switch 4] [--random 2] [--tau 0.1] [--jobs 5] [--seed-base 9100000000]
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
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
const games = Number(opt('--games', 60)), jobs = Number(opt('--jobs', 5)), seedBase = Number(opt('--seed-base', 9100000000));
const config = {topK: Number(opt('--top', 8)), switchK: Number(opt('--switch', 4)), randomK: Number(opt('--random', 2)), rollouts: Number(opt('--rollouts', 4)), maxTurns: 14};
const tau = Number(opt('--tau', 0.1));
const learnerPack = JSON.parse(readFileSync(opt('--team'), 'utf8')).pack;
const oppPacks = list(opt('--opp-teams')).map(path => JSON.parse(readFileSync(path, 'utf8')).pack);
const prng = n => { const rng = new showdown.PRNG(`41,53,${(n >>> 16) & 65535},${n & 65535}`); return () => rng.random(); };
const worker = process.env.SEARCH_EVAL_WORKER ? JSON.parse(process.env.SEARCH_EVAL_WORKER) : null;

function playGame(policy, oppAgent, seed, useSearch) {
  const learner = seed % 2 ? 'p1' : 'p2', foe = learner === 'p1' ? 'p2' : 'p1';
  const oppPack = oppPacks[(Math.imul(seed | 0, 2654435761) >>> 0) % oppPacks.length];
  const game = DirectGame.create(learner === 'p1' ? [learnerPack, oppPack] : [oppPack, learnerPack], [17, 29, (seed >>> 16) & 65535, seed & 65535]);
  const agents = {[learner]: policy, [foe]: oppAgent};
  const random = prng(seed * 2 + (useSearch ? 1 : 0));
  let voluntarySwitches = 0, decisions = 0, guard = 0;
  while (!game.ended && guard++ < 300) {
    for (const side of game.pending()) {
      const request = game.requests[side];
      if (side === learner && useSearch && request?.active && !request.teamPreview) {
        // Rollouts model BOTH sides with the learner's own policy: the search does not get to use the real opponent's behaviour.
        const result = searchDecision(game, side, {p1: policy, p2: policy}, random, config);
        // Sample from softmax(Q / tau) over the searched subset; ties keep the policy's own preference.
        const top = Math.max(...result.q), weights = result.q.map((q, i) => Math.exp((q - top) / tau) * (0.01 + result.prior[result.subset[i]]));
        let draw = random() * weights.reduce((a, b) => a + b, 0), pick = 0;
        for (let i = 0; i < weights.length; i++) { draw -= weights[i]; if (draw <= 0) { pick = i; break; } }
        const choice = result.encoded.candidates[result.subset[pick]].choice;
        const nextHidden = policy.predict(result.encoded, undefined, game.hidden[side]).hidden;
        if (game.choose(side, choice)) { game.hidden[side] = nextHidden; decisions++; if (choice.includes('switch') && !request.forceSwitch) voluntarySwitches++; continue; }
      }
      const choice = act(game, side, agents[side], random);
      if (side === learner && request?.active) { decisions++; if (choice.includes('switch') && !request.forceSwitch) voluntarySwitches++; }
    }
  }
  return {win: game.winner === learner ? 1 : game.winner ? 0 : 0.5, voluntarySwitches, decisions};
}

const loadAgents = () => ({policy: new Policy(JSON.parse(readFileSync(opt('--policy'), 'utf8'))),
  opp: opt('--opp', 'heuristic') === 'heuristic' ? 'heuristic' : new Policy(JSON.parse(readFileSync(opt('--opp'), 'utf8')))});

if (worker) {
  const {policy, opp} = loadAgents();
  const out = worker.seeds.map(seed => ({seed, plain: playGame(policy, opp, seed, false), search: playGame(policy, opp, seed, true)}));
  writeFileSync(worker.out, JSON.stringify(out));
  process.exit(0);
}
const dir = mkdtempSync(join(tmpdir(), 'search-eval-'));
const seeds = Array.from({length: games}, (_, i) => seedBase + i);
const started = Date.now();
await Promise.all(Array.from({length: jobs}, (_, k) => new Promise((resolve, reject) => {
  const proc = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {env: {...process.env,
    SEARCH_EVAL_WORKER: JSON.stringify({seeds: seeds.filter((_, i) => i % jobs === k), out: join(dir, `${k}.json`)})}, stdio: 'ignore'});
  proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`search-eval worker ${k} failed (${code})`)));
})));
const rows = Array.from({length: jobs}, (_, k) => JSON.parse(readFileSync(join(dir, `${k}.json`), 'utf8'))).flat();
rmSync(dir, {recursive: true, force: true});
const mean = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
const wilson = (p, n) => { const z = 1.96, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return [c - h, c + h].map(x => +x.toFixed(3)); };
const plain = mean(r => r.plain.win), search = mean(r => r.search.win);
console.log(JSON.stringify({games: rows.length, config, tau, seconds: +((Date.now() - started) / 1000).toFixed(0),
  plainWinRate: +plain.toFixed(3), plainCI95: wilson(plain, rows.length), searchWinRate: +search.toFixed(3), searchCI95: wilson(search, rows.length),
  voluntarySwitchesPerGame: {plain: +mean(r => r.plain.voluntarySwitches).toFixed(3), search: +mean(r => r.search.voluntarySwitches).toFixed(3)}}));
