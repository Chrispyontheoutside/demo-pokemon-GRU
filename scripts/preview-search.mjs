#!/usr/bin/env node
// Simulator search over team-preview choices (which 4 to bring and which 2 lead) for a fixed policy + team.
// Every selection "team abcd" (leads a,b unordered; back c,d unordered => 90 options) is played against a mixture of opponents
// (heuristic + frozen policies) on coherent opposing teams, with the learner's choice forced at preview and its own play otherwise.
// No external data; results are simulator win rates.
//
//   node scripts/preview-search.mjs --policy p.json --team team.json --opp-teams a.json,b.json [--opp-policies x.json,y.json]
//        [--games 40] [--jobs 5] [--seed-base 7000000000] [--out preview.json]
//   node scripts/preview-search.mjs ... --validate "team 1425" --validate-opp-teams held1.json,held2.json --games 200
//        compares a forced selection against the policy's own (sampled) preview on held-out teams.
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import showdown from 'pokemon-showdown';
import {Policy, play} from '../dist/src/champions-worker.js';
import {heuristic} from '../dist/src/champions.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const list = value => (value ?? '').split(',').filter(Boolean);
const policyPath = opt('--policy'), teamPath = opt('--team');
const oppTeams = list(opt('--opp-teams')).map(path => JSON.parse(readFileSync(path, 'utf8')).pack);
const oppPolicyPaths = list(opt('--opp-policies'));
const games = Number(opt('--games', 40)), jobs = Number(opt('--jobs', 5));
const seedBase = Number(opt('--seed-base', 7000000000));
const validate = opt('--validate');
const worker = process.env.PREVIEW_WORKER ? JSON.parse(process.env.PREVIEW_WORKER) : null;
const prng = n => { const rng = new showdown.PRNG(`41,53,${(n >>> 16) & 65535},${n & 65535}`); return () => rng.random(); };
const options = [];
for (let a = 1; a <= 6; a++) for (let b = a + 1; b <= 6; b++) for (let c = 1; c <= 6; c++) for (let d = c + 1; d <= 6; d++)
  if (![a, b].includes(c) && ![a, b].includes(d)) options.push(`team ${a}${b}${c}${d}`);

async function winRate(policy, opponents, pack, teams, forced, count, base, salt) {
  let wins = 0;
  for (let g = 0; g < count; g++) {
    const seed = base + salt * 1000 + g, learner = g % 2 ? 'p1' : 'p2', opponent = opponents[g % opponents.length];
    const rng = {p1: prng(seed * 2), p2: prng(seed * 2 + 1)};
    const opposingTeam = teams[(Math.imul(seed | 0, 2654435761) >>> 0) % teams.length];
    const result = await play(seed, (side, encoded, hidden, request) => {
      let pick;
      if (side === learner) {
        pick = policy.choose(encoded, rng[side], undefined, hidden);
        if (forced && request?.teamPreview) {
          const index = encoded.candidates.findIndex(candidate => candidate.choice === forced);
          if (index >= 0) pick = {...pick, action: index};
        }
      } else pick = opponent === 'heuristic' ? {action: heuristic(encoded), logp: 0, value: 0} : opponent.choose(encoded, rng[side], undefined, hidden);
      return {...pick, choice: encoded.candidates[pick.action].choice};
    }, 200, false, {[learner]: pack, [learner === 'p1' ? 'p2' : 'p1']: opposingTeam});
    wins += result.winner === learner ? 1 : result.winner ? 0 : 0.5;
  }
  return wins;
}
const load = () => ({
  policy: new Policy(JSON.parse(readFileSync(policyPath, 'utf8'))),
  pack: JSON.parse(readFileSync(teamPath, 'utf8')).pack,
  opponents: ['heuristic', ...oppPolicyPaths.map(path => new Policy(JSON.parse(readFileSync(path, 'utf8'))))],
});

if (worker) {
  const {policy, pack, opponents} = load();
  const out = [];
  for (const index of worker.indices) out.push({option: options[index], wins: await winRate(policy, opponents, pack, oppTeams, options[index], worker.games, seedBase, index)});
  writeFileSync(worker.out, JSON.stringify(out));
  process.exit(0);
}

if (validate) {
  const heldOut = list(opt('--validate-opp-teams')).map(path => JSON.parse(readFileSync(path, 'utf8')).pack);
  const {policy, pack, opponents} = load();
  const forced = await winRate(policy, opponents, pack, heldOut, validate, games, seedBase + 500000000, 1);
  const own = await winRate(policy, opponents, pack, heldOut, null, games, seedBase + 500000000, 1);
  console.log(JSON.stringify({validate, games, forcedWinRate: forced / games, policyOwnPreviewWinRate: own / games, heldOutTeams: heldOut.length}));
  process.exit(0);
}

if (!policyPath || !teamPath || !oppTeams.length) throw new Error('--policy, --team and --opp-teams are required');
const dir = mkdtempSync(join(tmpdir(), 'preview-search-'));
const shards = Array.from({length: jobs}, (_, k) => options.map((_, i) => i).filter(i => i % jobs === k));
await Promise.all(shards.map((indices, k) => new Promise((resolve, reject) => {
  const proc = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {env: {...process.env, PREVIEW_WORKER: JSON.stringify({indices, games, out: join(dir, `${k}.json`)})}, stdio: 'ignore'});
  proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`preview worker ${k} failed (${code})`)));
})));
const results = shards.flatMap((_, k) => JSON.parse(readFileSync(join(dir, `${k}.json`), 'utf8'))).map(r => ({option: r.option, winRate: r.wins / games}));
rmSync(dir, {recursive: true, force: true});
results.sort((a, b) => b.winRate - a.winRate);
const report = {policy: policyPath, team: teamPath, gamesPerOption: games, opponentPolicies: oppPolicyPaths, opponentTeams: oppTeams.length, ranked: results};
const out = opt('--out');
if (out) writeFileSync(out, JSON.stringify(report, null, 1));
console.log(`best ${results[0].option} ${results[0].winRate.toFixed(3)} | median ${results[Math.floor(results.length / 2)].winRate.toFixed(3)} | worst ${results.at(-1).option} ${results.at(-1).winRate.toFixed(3)}`);
console.log(results.slice(0, 6).map(r => `${r.option}:${r.winRate.toFixed(2)}`).join('  '));
