#!/usr/bin/env node
// Evolutionary local team discovery for Reg M-C: rate teams by simulator results, keep elites, recombine/mutate them
// (every child is validated by the format's validator), and co-evolve: opposing teams are drawn from the current elite.
// No external team data; all teams come from the local generator plus recombination.
//
//   node scripts/team-evolve.mjs --pilot p.json --pool a.json,b.json [--population 200] [--generations 10] [--games 24]
//        [--jobs 6] [--elite 0.25] [--seed 8000] [--out runs/champions-vgc-2026-reg-mc/teams/evolved]
import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import showdown from 'pokemon-showdown';
import {Policy, play, makeTeam} from '../dist/src/champions-worker.js';
import {heuristic} from '../dist/src/champions.js';

const {Teams, TeamValidator, PRNG, Dex} = showdown;
const FORMAT = 'gen9championsvgc2026regmc';
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const pilotPath = opt('--pilot');
const poolPaths = (opt('--pool', '') || '').split(',').filter(Boolean);
const population = Number(opt('--population', 200)), generations = Number(opt('--generations', 10));
const games = Number(opt('--games', 24)), jobs = Number(opt('--jobs', 6)), eliteShare = Number(opt('--elite', 0.25));
const seedStart = Number(opt('--seed', 8000));
const outDir = opt('--out', 'runs/champions-vgc-2026-reg-mc/teams/evolved');
const worker = process.env.EVOLVE_WORKER ? JSON.parse(process.env.EVOLVE_WORKER) : null;
const prng = n => { const rng = new showdown.PRNG(`41,53,${(n >>> 16) & 65535},${n & 65535}`); return () => rng.random(); };
const validator = new TeamValidator(FORMAT);
const species = pack => Teams.unpack(pack).map(set => set.species || set.name);

async function fitness(policy, opponents, pack, opposing, base, index) {
  let wins = 0;
  for (let g = 0; g < games; g++) {
    const seed = base + index * 1000 + g, learner = g % 2 ? 'p1' : 'p2', opponent = opponents[g % opponents.length];
    const rng = {p1: prng(seed * 2), p2: prng(seed * 2 + 1)};
    const theirs = opposing[(Math.imul(seed | 0, 2654435761) >>> 0) % opposing.length];
    const result = await play(seed, (side, encoded, hidden) => {
      const pick = side === learner ? policy.choose(encoded, rng[side], undefined, hidden)
        : opponent === 'heuristic' ? {action: heuristic(encoded), logp: 0, value: 0} : opponent.choose(encoded, rng[side], undefined, hidden);
      return {...pick, choice: encoded.candidates[pick.action].choice};
    }, 200, false, {[learner]: pack, [learner === 'p1' ? 'p2' : 'p1']: theirs});
    wins += result.winner === learner ? 1 : result.winner ? 0 : 0.5;
  }
  return wins / games;
}
const loadAgents = () => ({policy: new Policy(JSON.parse(readFileSync(pilotPath, 'utf8'))),
  opponents: ['heuristic', ...poolPaths.map(path => new Policy(JSON.parse(readFileSync(path, 'utf8'))))]});

if (worker) {
  const {policy, opponents} = loadAgents();
  const out = [];
  for (const item of worker.items) out.push({index: item.index, fitness: await fitness(policy, opponents, item.pack, worker.opposing, worker.base, item.index)});
  writeFileSync(worker.out, JSON.stringify(out));
  process.exit(0);
}

async function evaluate(teams, opposing, base) {
  const dir = mkdtempSync(join(tmpdir(), 'evolve-'));
  const shards = Array.from({length: jobs}, (_, k) => teams.map((pack, index) => ({index, pack})).filter(item => item.index % jobs === k));
  await Promise.all(shards.map((items, k) => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {env: {...process.env,
      EVOLVE_WORKER: JSON.stringify({items, opposing, base, out: join(dir, `${k}.json`)})}, stdio: 'ignore'});
    proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`evolve worker ${k} failed (${code})`)));
  })));
  const scores = new Array(teams.length);
  for (let k = 0; k < jobs; k++) for (const {index, fitness: f} of JSON.parse(readFileSync(join(dir, `${k}.json`), 'utf8'))) scores[index] = f;
  rmSync(dir, {recursive: true, force: true});
  return scores;
}

const rand = prng(seedStart * 7 + 3);
const pick = list => list[Math.floor(rand() * list.length)];
let freshCounter = 0;
const freshTeam = () => makeTeam([37, 91, (seedStart + freshCounter) >>> 16 & 65535, (seedStart + freshCounter++) & 65535]);
function child(elites) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const a = Teams.unpack(pick(elites).pack);
    let sets;
    if (rand() < 0.5) {                       // crossover: 3–4 members from A, the rest from B
      const b = Teams.unpack(pick(elites).pack), take = 3 + Math.floor(rand() * 2);
      sets = [...a.slice().sort(() => rand() - 0.5).slice(0, take), ...b.slice().sort(() => rand() - 0.5)];
    } else {                                  // mutation: swap 1–2 members for members of a freshly generated team
      const donor = Teams.unpack(freshTeam()).sort(() => rand() - 0.5);
      const swaps = 1 + Math.floor(rand() * 2);
      sets = [...a.slice().sort(() => rand() - 0.5).slice(0, 6 - swaps), ...donor.slice(0, swaps)];
    }
    const seen = new Set(), members = [];
    for (const set of sets) { const id = Dex.species.get(set.species || set.name).baseSpecies; if (!seen.has(id) && members.length < 6) { seen.add(id); members.push(set); } }
    if (members.length < 6) continue;
    if (!validator.validateTeam(members)) return Teams.pack(members);
  }
  return freshTeam();
}

mkdirSync(outDir, {recursive: true});
let teams = Array.from({length: population}, () => freshTeam());
let opposing = Array.from({length: 24}, () => freshTeam());
let ranked = [];
const started = Date.now();
for (let generation = 0; generation < generations; generation++) {
  const scores = await evaluate(teams, opposing, 9000000000 + generation * 100000000);
  ranked = teams.map((pack, i) => ({pack, fitness: scores[i]})).sort((a, b) => b.fitness - a.fitness);
  const elites = ranked.slice(0, Math.max(4, Math.round(population * eliteShare)));
  console.error(`generation ${generation + 1}/${generations}: best ${ranked[0].fitness.toFixed(3)} elite-mean ${(elites.reduce((s, t) => s + t.fitness, 0) / elites.length).toFixed(3)} median ${ranked[Math.floor(ranked.length / 2)].fitness.toFixed(3)} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  // Co-evolution: next generation's opponents are the current elite mixed with a few fresh random teams.
  opposing = [...elites.slice(0, 18).map(t => t.pack), ...Array.from({length: 6}, () => freshTeam())];
  teams = [...elites.map(t => t.pack), ...Array.from({length: population - elites.length}, () => child(elites))];
}
const final = await evaluate(ranked.slice(0, 40).map(t => t.pack), opposing, 9900000000);
const finalRanked = ranked.slice(0, 40).map((t, i) => ({pack: t.pack, fitness: final[i], species: species(t.pack), teamSHA256: createHash('sha256').update(t.pack).digest('hex')})).sort((a, b) => b.fitness - a.fitness);
writeFileSync(join(outDir, `evolved-${new Date().toISOString().replaceAll(':', '-')}.json`), JSON.stringify({pilot: pilotPath, pool: poolPaths, population, generations, gamesPerTeam: games, ranked: finalRanked}, null, 1));
console.log(finalRanked.slice(0, 10).map(t => `${t.fitness.toFixed(3)} ${t.species.join(', ')}`).join('\n'));
