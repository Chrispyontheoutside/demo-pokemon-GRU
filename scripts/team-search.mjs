#!/usr/bin/env node
// Local team search for the ladder: generate many legal Reg M-C teams, rate them by real simulator results with a fixed
// policy against a diverse opponent set (heuristic + frozen historical policies, each on freshly generated opposing teams),
// and keep the survivors of a successive-halving tournament. No external team data is used.
//
//   node scripts/team-search.mjs --policy champion.json --pool a.json,b.json [--candidates 240] [--jobs 4]
//        [--stage-games 12,48,160] [--keep 0.25,6] [--seed-base 5000000000] [--out runs/champions-vgc-2026-reg-mc/teams]
import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import showdown from 'pokemon-showdown';
import {Policy, play, makeTeam} from '../dist/src/champions-worker.js';
import {heuristic} from '../dist/src/champions.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const policyPath = opt('--policy');
const poolPaths = (opt('--pool', '') || '').split(',').filter(Boolean);
const candidates = Number(opt('--candidates', 240));
const jobs = Number(opt('--jobs', 4));
const stageGames = opt('--stage-games', '12,48,160').split(',').map(Number);
const keep = opt('--keep', '0.25,6').split(',').map(Number);
const seedBase = Number(opt('--seed-base', 5000000000));
// --opponent-teams a.json,b.json: the opposing side plays these strong teams (chosen from the game seed) instead of random ones.
const opponentTeams = (opt('--opponent-teams', '') || '').split(',').filter(Boolean).map(path => JSON.parse(readFileSync(path, 'utf8')).pack);
const outDir = opt('--out', 'runs/champions-vgc-2026-reg-mc/teams');
const worker = process.env.TEAM_SEARCH_WORKER ? JSON.parse(process.env.TEAM_SEARCH_WORKER) : null;
const prng = n => { const rng = new showdown.PRNG(`41,53,${(n >>> 16) & 65535},${n & 65535}`); return () => rng.random(); };
const teamFor = index => makeTeam([31, 41, (index >>> 16) & 65535, index & 65535]);
const species = pack => pack.split(']').map(m => m.split('|')[1] || m.split('|')[0]).filter(Boolean);

async function evaluate(policy, opponents, teamIndex, pack, games, base) {
  let wins = 0;
  for (let g = 0; g < games; g++) {
    const seed = base + teamIndex * 1000 + g;
    const learner = g % 2 ? 'p1' : 'p2';
    const opp = opponents[g % opponents.length];
    const rng = {p1: prng(seed * 2), p2: prng(seed * 2 + 1)};
    const result = await play(seed, (side, encoded, hidden) => {
      const pick = side === learner ? policy.choose(encoded, rng[side], undefined, hidden)
        : opp === 'heuristic' ? {action: heuristic(encoded), logp: 0, value: 0} : opp.choose(encoded, rng[side], undefined, hidden);
      return {...pick, choice: encoded.candidates[pick.action].choice};
    }, 200, false, {[learner]: pack, ...(opponentTeams.length ? {[learner === 'p1' ? 'p2' : 'p1']: opponentTeams[(Math.imul(seed | 0, 2654435761) >>> 0) % opponentTeams.length]} : {})});
    wins += result.winner === learner ? 1 : result.winner ? 0 : 0.5;
  }
  return wins;
}

if (worker) {
  const policy = new Policy(JSON.parse(readFileSync(policyPath, 'utf8')));
  const opponents = ['heuristic', ...poolPaths.map(path => new Policy(JSON.parse(readFileSync(path, 'utf8'))))];
  const out = [];
  for (const index of worker.indices) out.push({index, wins: await evaluate(policy, opponents, index, worker.packs[String(index)], worker.games, worker.base)});
  writeFileSync(worker.out, JSON.stringify(out));
  process.exit(0);
}

async function runStage(indices, packs, games, base) {
  const dir = mkdtempSync(join(tmpdir(), 'team-search-'));
  const shards = Array.from({length: jobs}, (_, k) => indices.filter((_, i) => i % jobs === k)).filter(shard => shard.length);
  await Promise.all(shards.map((shard, k) => new Promise((resolve, reject) => {
    const payload = {indices: shard, packs: Object.fromEntries(shard.map(i => [String(i), packs[i]])), games, base, out: join(dir, `${k}.json`)};
    const proc = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {env: {...process.env, TEAM_SEARCH_WORKER: JSON.stringify(payload)}, stdio: ['ignore', 'ignore', 'ignore']});
    proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`team-search worker ${k} failed (${code})`)));
  })));
  const results = shards.flatMap((_, k) => JSON.parse(readFileSync(join(dir, `${k}.json`), 'utf8')));
  rmSync(dir, {recursive: true, force: true});
  return results;
}

if (!policyPath) throw new Error('--policy is required');
mkdirSync(outDir, {recursive: true});
const started = Date.now();
const packs = {};
for (let i = 0; i < candidates; i++) packs[i] = teamFor(i);
let alive = Object.keys(packs).map(Number);
const table = Object.fromEntries(alive.map(i => [i, {index: i, pack: packs[i], species: species(packs[i]), wins: 0, games: 0}]));
for (let stage = 0; stage < stageGames.length; stage++) {
  const results = await runStage(alive, packs, stageGames[stage], seedBase + stage * 100000000);
  for (const {index, wins} of results) { table[index].wins += wins; table[index].games += stageGames[stage]; table[index].stageRates = [...(table[index].stageRates ?? []), wins / stageGames[stage]]; }
  // Rank by the latest stage only (fresh games), so survivors are re-tested rather than carried by earlier luck.
  alive = [...alive].sort((a, b) => table[b].stageRates.at(-1) - table[a].stageRates.at(-1));
  const next = stage < keep.length ? keep[stage] : null;
  const count = next === null ? alive.length : next < 1 ? Math.max(1, Math.ceil(alive.length * next)) : Math.min(alive.length, next);
  console.error(`stage ${stage + 1}: ${alive.length} teams x ${stageGames[stage]} games; best ${table[alive[0]].stageRates.at(-1).toFixed(3)} median ${table[alive[Math.floor(alive.length / 2)]].stageRates.at(-1).toFixed(3)}; keeping ${count} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  alive = alive.slice(0, count);
}
const ranked = alive.map(i => ({...table[i], winRate: table[i].wins / table[i].games, teamSHA256: createHash('sha256').update(table[i].pack).digest('hex')}));
const everyone = Object.values(table).map(t => t.stageRates[0]);
const report = {generatedAt: new Date().toISOString(), policy: policyPath, pool: poolPaths, candidates, stageGames, seedBase,
  firstStageMeanWinRate: everyone.reduce((a, b) => a + b, 0) / everyone.length, elapsedSeconds: (Date.now() - started) / 1000, ranked};
const file = join(outDir, `search-${report.generatedAt.replaceAll(':', '-')}.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(file);
for (const t of ranked) console.log(`${t.winRate.toFixed(3)} (${t.games}g, per-stage ${t.stageRates.map(r => r.toFixed(2)).join('/')}) ${t.species.join(', ')}`);
