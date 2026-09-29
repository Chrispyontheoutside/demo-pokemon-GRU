import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import showdown from 'pokemon-showdown';
import {Policy, play} from '../dist/src/champions-worker.js';
import {heuristic} from '../dist/src/champions.js';

const format = 'gen9championsvgc2026regmb';
const checkpointPath = process.argv[2] ?? 'runs/champions-vgc-2026-reg-mb/seed-20260946/policy.json';
const pairs = Number(process.argv[3] ?? 100);
const seed = Number(process.argv[4] ?? 3000000000);
const additionalSimpleScoreWeight = Number(process.argv[5] ?? 0);
if (!Number.isInteger(pairs) || pairs < 1 || pairs > 1000 || !Number.isInteger(seed) || seed < 0 ||
    !Number.isFinite(additionalSimpleScoreWeight)) {
  throw new Error('Usage: node scripts/evaluate-champions-vgc.mjs [checkpoint.json] [pairs: 1..1000] [seed] [simpleScoreWeight]');
}
const raw = readFileSync(checkpointPath, 'utf8');
const checkpoint = JSON.parse(raw);
const simpleScoreWeight = Number(checkpoint.simpleScoreWeight ?? 0);
const policy = new Policy(checkpoint);
assert.equal(checkpoint.format, format);
const ledgerPath = 'reports/champions-vgc-2026-reg-mb/experiment-ledger.json';
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
const reportsDir = fileURLToPath(new URL('../reports/champions-vgc-2026-reg-mb/', import.meta.url));
mkdirSync(reportsDir, {recursive: true});
const reportPath = join(reportsDir, `evaluation-${new Date().toISOString().replaceAll(':','-')}.json`);
const digest = createHash('sha256').update(raw).digest('hex');
let generated = 0, completed = 0, truncated = 0, aborted = 0;
const saveLedger = () => {
  const out = {...ledger,
    evaluationBattles: Number(ledger.evaluationBattles ?? 0) + generated,
    evaluationCompletedBattles: Number(ledger.evaluationCompletedBattles ?? 0) + completed,
    evaluationTruncatedBattles: Number(ledger.evaluationTruncatedBattles ?? 0) + truncated,
    evaluationAbortedBattles: Number(ledger.evaluationAbortedBattles ?? 0) + aborted,
    lastUpdatedAt: new Date().toISOString()};
  const tmp = `${ledgerPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
  renameSync(tmp, ledgerPath);
};
const prng = n => {
  const rng = new showdown.PRNG(`41,53,${(n >>> 16) & 65535},${n & 65535}`);
  return () => rng.random();
};

async function battle(seedIndex, learnerSide, baseline) {
  generated++;
  saveLedger();
  const random = {p1: prng(seedIndex * 2), p2: prng(seedIndex * 2 + 1)};
  try {
    const result = await play(seedIndex, (side, encoded) => {
      let action, logp = 0, value = 0;
      if (side === learnerSide) ({action, logp, value} = policy.choose(encoded, random[side], simpleScoreWeight + additionalSimpleScoreWeight));
      else if (baseline === 'random') action = Math.floor(random[side]() * encoded.candidates.length);
      else action = heuristic(encoded);
      return {action, logp, value, choice: encoded.candidates[action].choice};
    });
    if (result.truncated) truncated++;
    else completed++;
    saveLedger();
    return result;
  } catch (error) {
    aborted++;
    saveLedger();
    throw error;
  }
}

const results = [];
for (const baseline of ['random','heuristic']) {
  const pairRows = [];
  for (let pair = 0; pair < pairs; pair++) {
    const pairSeed = seed + (baseline === 'heuristic' ? 1000000 : 0) + pair;
    const first = await battle(pairSeed, 'p1', baseline);
    const second = await battle(pairSeed, 'p2', baseline);
    if (first.truncated || second.truncated) throw new Error(`Capped evaluation pair at seed ${pairSeed}`);
    const firstScore = first.winner === 'p1' ? 1 : first.winner ? 0 : .5;
    const secondScore = second.winner === 'p2' ? 1 : second.winner ? 0 : .5;
    pairRows.push({seed:pairSeed,firstWinner:first.winner,secondWinner:second.winner,pairedScore:(firstScore+secondScore)/2});
    if ((pair + 1) % 25 === 0) console.log(JSON.stringify({event:'evaluation-progress',baseline,pairs:pair+1,totalPairs:pairs,generated,completed}));
  }
  const scores = pairRows.map(row => row.pairedScore);
  const resample = prng(seed + (baseline === 'heuristic' ? 900000000 : 800000000));
  const bootstrap = [];
  for (let b = 0; b < 10000; b++) {
    let total = 0;
    for (let i = 0; i < scores.length; i++) total += scores[Math.floor(resample() * scores.length)];
    bootstrap.push(total / scores.length);
  }
  bootstrap.sort((a,b) => a-b);
  results.push({baseline,pairs,battles:pairs*2,
    wins:pairRows.reduce((n,row) => n+Number(row.firstWinner==='p1')+Number(row.secondWinner==='p2'),0),
    losses:pairRows.reduce((n,row) => n+Number(!!row.firstWinner&&row.firstWinner!=='p1')+Number(!!row.secondWinner&&row.secondWinner!=='p2'),0),
    ties:pairRows.reduce((n,row) => n+Number(!row.firstWinner)+Number(!row.secondWinner),0),
    score:scores.reduce((a,b)=>a+b,0)/scores.length,paired95ci:[bootstrap[250],bootstrap[9749]],pairsData:pairRows});
}
const report = {format,checkpoint:checkpointPath,checkpointSHA256:digest,steps:checkpoint.steps,
  simpleScoreWeight,additionalSimpleScoreWeight,effectiveSimpleScoreWeight:simpleScoreWeight+additionalSimpleScoreWeight,
  selfPlayBattlesGenerated:checkpoint.selfPlayBattlesGenerated,selfPlayBattlesUsedForPPO:checkpoint.selfPlayBattlesUsedForPPO,
  initialization:'random; no demonstration data',externalReplayTrainingBattles:0,
  seed,pairsPerBaseline:pairs,generated,completed,truncated,aborted,runs:results};
writeFileSync(reportPath, `${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify({event:'evaluation-complete',reportPath,...report,runs:results.map(({pairsData,...row})=>row)},null,2));
