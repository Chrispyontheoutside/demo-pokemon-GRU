import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import showdown from 'pokemon-showdown';
import {CHAMPIONS_TEAM_GENERATOR_VERSION, Policy, guardedAction, humanAction, play} from '../dist/src/champions-worker.js';
import {heuristic} from '../dist/src/champions.js';

const format = 'gen9championsvgc2026regmc';
const checkpointPath = process.argv[2] ?? 'runs/champions-vgc-2026-reg-mc/seed-20260929/policy.json';
const pairs = Number(process.argv[3] ?? 100);
const seed = Number(process.argv[4] ?? 3000000000);
const additionalSimpleScoreWeight = Number(process.argv[5] ?? 0);
const frozenOpponentPath = process.argv[6];
if (!Number.isInteger(pairs) || pairs < 1 || pairs > 1000 || !Number.isInteger(seed) || seed < 0 ||
    !Number.isFinite(additionalSimpleScoreWeight)) {
  throw new Error('Usage: node scripts/evaluate-champions-vgc.mjs [checkpoint.json] [pairs: 1..1000] [seed] [simpleScoreWeight]');
}
const raw = readFileSync(checkpointPath, 'utf8');
const checkpoint = JSON.parse(raw);
const simpleScoreWeight = Number(checkpoint.simpleScoreWeight ?? 0);
const policy = new Policy(checkpoint);
assert.equal(checkpoint.format, format);
const frozenRaw = frozenOpponentPath ? readFileSync(frozenOpponentPath, 'utf8') : null;
const frozenCheckpoint = frozenRaw ? JSON.parse(frozenRaw) : null;
const frozenPolicy = frozenCheckpoint ? new Policy(frozenCheckpoint) : null;
// EVAL_LEARNER_TEAM=<team.json> puts the evaluated policy on a fixed team (its ladder configuration); opponents keep generated teams.
const learnerTeam = process.env.EVAL_LEARNER_TEAM ? JSON.parse(readFileSync(process.env.EVAL_LEARNER_TEAM, 'utf8')).pack : undefined;
// EVAL_OPPONENT_TEAMS=a.json,b.json: the opponent side plays one of these (strong, coherent) teams, chosen from the pair seed.
const opponentTeams = (process.env.EVAL_OPPONENT_TEAMS ?? '').split(',').filter(Boolean).map(path => JSON.parse(readFileSync(path, 'utf8')).pack);
const temperature = Number(process.env.EVAL_TEMPERATURE ?? 1);   // play-time temperature for the evaluated policy (0 = greedy)
const GAMMA = 0.99;
// Evaluations no longer write a shared ledger (concurrent runs would race); each report carries its own battle counts.
// Set CHAMPIONS_EVAL_LEDGER to a per-experiment file to keep a running total.
const ledgerPath = process.env.CHAMPIONS_EVAL_LEDGER;
const ledger = ledgerPath && existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : {};
// EVAL_JOBS>1 shards pair ranges across child processes; merged reports are identical to a single-process run.
const jobs = Math.max(1, Math.floor(Number(process.env.EVAL_JOBS ?? 1)));
const child = process.env.EVAL_CHILD ? JSON.parse(process.env.EVAL_CHILD) : null;
const reportsDir = fileURLToPath(new URL('../reports/champions-vgc-2026-reg-mc/', import.meta.url));
mkdirSync(reportsDir, {recursive: true});
const reportPath = join(reportsDir, `evaluation-${new Date().toISOString().replaceAll(':','-')}.json`);
const digest = createHash('sha256').update(raw).digest('hex');
let generated = 0, completed = 0, truncated = 0, aborted = 0;
const diagnosticsByBaseline = {};
let hiddenTrapReveals = 0, illegalActionRetries = 0;
const baselines = ['random','heuristic', ...(process.env.EVAL_GUARDED ? ['guarded'] : []), ...(process.env.EVAL_HUMAN ? ['human'] : []), ...(frozenPolicy ? ['frozen'] : [])];
const policyStats = Object.fromEntries(baselines.map(baseline => [baseline, {entropy:[],values:[],outcomes:[],targets:[]} ]));
const saveLedger = () => {
  if (!ledgerPath || child) return;
  const out = {...ledger,
    evaluationBattles: Number(ledger.evaluationBattles ?? 0) + generated,
    evaluationCompletedBattles: Number(ledger.evaluationCompletedBattles ?? 0) + completed,
    evaluationTruncatedBattles: Number(ledger.evaluationTruncatedBattles ?? 0) + truncated,
    evaluationAbortedBattles: Number(ledger.evaluationAbortedBattles ?? 0) + aborted,
    lastUpdatedAt: new Date().toISOString()};
  out.totalMCLocalBattlesGenerated = ['randomThroughputBenchmarkBattles','preflightRandomPolicyBattlesGenerated',
    'selfPlayBattlesGenerated','baselineTrainingBattlesGenerated','evaluationBattles','ladderBattlesStarted']
    .reduce((total,key) => total + Number(out[key] ?? 0), 0);
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
    const result = await play(seedIndex, (side, encoded, hidden, request, view) => {
      let action, logp = 0, value = 0, entropy = 0;
      let nextHidden;
      if (side === learnerSide) ({action, logp, value, entropy, nextHidden} = policy.choose(encoded, random[side], simpleScoreWeight + additionalSimpleScoreWeight, hidden, temperature));
      else if (baseline === 'random') action = Math.floor(random[side]() * encoded.candidates.length);
      else if (baseline === 'heuristic') action = heuristic(encoded);
      else if (baseline === 'guarded') action = guardedAction(encoded, request, random[side]);
      else if (baseline === 'human') action = humanAction(encoded, request, random[side], view, side);
      else ({action, nextHidden} = frozenPolicy.choose(encoded, random[side], undefined, hidden));
      return {action, logp, value, entropy, nextHidden, choice: encoded.candidates[action].choice};
    }, 200, false, {...(learnerTeam ? {[learnerSide]: learnerTeam} : {}),
      ...(opponentTeams.length ? {[learnerSide === 'p1' ? 'p2' : 'p1']: opponentTeams[(Math.imul(seedIndex | 0, 2654435761) >>> 0) % opponentTeams.length]} : {})});
    const learnerEpisode = result.episodes.find(episode => episode.side === learnerSide);
    (diagnosticsByBaseline[baseline] ??= []).push(...result.rejectionDiagnostics);
    hiddenTrapReveals += result.hiddenTrapReveals;
    illegalActionRetries += result.illegalActionRetries;
    if (learnerEpisode) learnerEpisode.steps.forEach((step, index) => {
      const decisionsToTerminal = learnerEpisode.steps.length - index - 1;
      policyStats[baseline].entropy.push(step.entropy);
      policyStats[baseline].values.push(step.value);
      policyStats[baseline].outcomes.push(learnerEpisode.reward);
      policyStats[baseline].targets.push(learnerEpisode.reward * GAMMA ** decisionsToTerminal);
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

const pairRange = async (baseline, start, end) => {
  const rows = [];
  for (let pair = start; pair < end; pair++) {
    const pairSeed = seed + (baseline === 'heuristic' ? 1000000 : baseline === 'frozen' ? 2000000 : baseline === 'guarded' ? 3000000 : baseline === 'human' ? 4000000 : 0) + pair;
    const first = await battle(pairSeed, 'p1', baseline);
    const second = await battle(pairSeed, 'p2', baseline);
    if (first.truncated || second.truncated) throw new Error(`Capped evaluation pair at seed ${pairSeed}`);
    const firstScore = first.winner === 'p1' ? 1 : first.winner ? 0 : .5;
    const secondScore = second.winner === 'p2' ? 1 : second.winner ? 0 : .5;
    rows.push({seed:pairSeed,firstWinner:first.winner,secondWinner:second.winner,pairedScore:(firstScore+secondScore)/2});
    if (!child && (pair + 1) % 25 === 0) console.log(JSON.stringify({event:'evaluation-progress',baseline,pairs:pair+1,totalPairs:pairs,generated,completed}));
  }
  return rows;
};

const pairRowsByBaseline = {};
if (child) {
  for (const baseline of baselines) pairRowsByBaseline[baseline] = await pairRange(baseline, child.start, child.end);
  writeFileSync(child.out, JSON.stringify({pairRowsByBaseline, policyStats, diagnosticsByBaseline, generated, completed, truncated, aborted, hiddenTrapReveals, illegalActionRetries}));
  process.exit(0);
}
if (jobs > 1) {
  const bounds = Array.from({length: jobs + 1}, (_, k) => Math.round(k * pairs / jobs));
  const shardDir = mkdtempSync(join(tmpdir(), 'champions-eval-'));
  const shards = await Promise.all(Array.from({length: jobs}, (_, k) => new Promise((resolve, reject) => {
    if (bounds[k] === bounds[k + 1]) return resolve(null);
    const proc = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      {env: {...process.env, EVAL_JOBS: '1', EVAL_CHILD: JSON.stringify({start: bounds[k], end: bounds[k + 1], out: join(shardDir, `shard-${k}.json`)})}, stdio: ['ignore', 'ignore', 'inherit']});
    proc.on('exit', code => {
      code === 0 ? resolve(JSON.parse(readFileSync(join(shardDir, `shard-${k}.json`), 'utf8'))) : reject(new Error(`Evaluation shard ${k} failed with code ${code}`));
    });
  })));
  rmSync(shardDir, {recursive: true, force: true});
  for (const shard of shards.filter(Boolean)) {   // shards are in pair order, so merged arrays match a serial run
    for (const baseline of baselines) {
      (pairRowsByBaseline[baseline] ??= []).push(...shard.pairRowsByBaseline[baseline]);
      for (const key of Object.keys(policyStats[baseline])) policyStats[baseline][key].push(...shard.policyStats[baseline][key]);
      (diagnosticsByBaseline[baseline] ??= []).push(...(shard.diagnosticsByBaseline[baseline] ?? []));
    }
    generated += shard.generated; completed += shard.completed; truncated += shard.truncated; aborted += shard.aborted;
    hiddenTrapReveals += shard.hiddenTrapReveals; illegalActionRetries += shard.illegalActionRetries;
  }
  saveLedger();
} else {
  for (const baseline of baselines) pairRowsByBaseline[baseline] = await pairRange(baseline, 0, pairs);
}

const results = [];
for (const baseline of baselines) {
  const pairRows = pairRowsByBaseline[baseline];
  const scores = pairRows.map(row => row.pairedScore);
  const resample = prng(seed + (baseline === 'heuristic' ? 900000000 : 800000000));
  const bootstrap = [];
  for (let b = 0; b < 10000; b++) {
    let total = 0;
    for (let i = 0; i < scores.length; i++) total += scores[Math.floor(resample() * scores.length)];
    bootstrap.push(total / scores.length);
  }
  bootstrap.sort((a,b) => a-b);
  const stats = policyStats[baseline];
  const mean = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;
  const min = values => values.length ? Math.min(...values) : null;
  const max = values => values.length ? Math.max(...values) : null;
  const meanAbsError = stats.values.length ? mean(stats.values.map((value,i)=>Math.abs(value-stats.targets[i]))) : null;
  const meanSquaredError = stats.values.length ? mean(stats.values.map((value,i)=>(value-stats.targets[i])**2)) : null;
  const variance = values => {
    if (!values.length) return null;
    const average = mean(values);
    return mean(values.map(value => (value-average)**2));
  };
  const correlation = (left,right) => {
    if (left.length < 2) return null;
    const leftMean = mean(left), rightMean = mean(right);
    const covariance = mean(left.map((value,index) => (value-leftMean)*(right[index]-rightMean)));
    const denominator = Math.sqrt(variance(left)*variance(right));
    return denominator > 0 ? covariance/denominator : null;
  };
  const targetVariance = variance(stats.targets);
  const residuals = stats.values.map((value,index) => stats.targets[index]-value);
  const explainedVariance = targetVariance > 0 ? 1 - variance(residuals)/targetVariance : null;
  results.push({baseline,pairs,battles:pairs*2,
    wins:pairRows.reduce((n,row) => n+Number(row.firstWinner==='p1')+Number(row.secondWinner==='p2'),0),
    losses:pairRows.reduce((n,row) => n+Number(!!row.firstWinner&&row.firstWinner!=='p1')+Number(!!row.secondWinner&&row.secondWinner!=='p2'),0),
    ties:pairRows.reduce((n,row) => n+Number(!row.firstWinner)+Number(!row.secondWinner),0),
    score:scores.reduce((a,b)=>a+b,0)/scores.length,paired95ci:[bootstrap[250],bootstrap[9749]],
    policyMetrics:{decisionCount:stats.entropy.length,meanEntropy:mean(stats.entropy),
      predictedValue:{min:min(stats.values),mean:mean(stats.values),max:max(stats.values)},
      target:{min:min(stats.targets),mean:mean(stats.targets),max:max(stats.targets),kind:'gamma-discounted terminal outcome',gamma:GAMMA},
      observedOutcomeMean:mean(stats.outcomes),valueMAE:meanAbsError,valueMSE:meanSquaredError,
      valueRMSE:meanSquaredError === null ? null : Math.sqrt(meanSquaredError),
      outcomeCorrelation:correlation(stats.values,stats.outcomes),explainedVariance,
      predictionOutsideTargetRangePercent:stats.values.length ? 100*stats.values.filter(value=>value < -1 || value > 1).length/stats.values.length : null},pairsData:pairRows});
}
const report = {format,teamGeneratorVersion:CHAMPIONS_TEAM_GENERATOR_VERSION,checkpoint:checkpointPath,checkpointSHA256:digest,steps:checkpoint.steps,
  frozenOpponent:frozenOpponentPath ?? null,
  frozenOpponentSHA256:frozenRaw ? createHash('sha256').update(frozenRaw).digest('hex') : null,
  simpleScoreWeight,additionalSimpleScoreWeight,effectiveSimpleScoreWeight:simpleScoreWeight+additionalSimpleScoreWeight,
  selfPlayBattlesGenerated:checkpoint.selfPlayBattlesGenerated,selfPlayBattlesUsedForPPO:checkpoint.selfPlayBattlesUsedForPPO,
  baselineTrainingBattlesUsedForPPO:checkpoint.baselineTrainingBattlesUsedForPPO,
  initialization:checkpoint.initialization ?? 'random; no demonstration data',externalReplayTrainingBattles:0,
  learnerTeamSHA256: learnerTeam ? createHash('sha256').update(learnerTeam).digest('hex') : null,
  seed,pairsPerBaseline:pairs,generated,completed,truncated,aborted,runs:results};
report.rejectionDiagnostics = baselines.flatMap(baseline => diagnosticsByBaseline[baseline] ?? []);
report.hiddenTrapReveals = hiddenTrapReveals;
report.illegalActionRetries = illegalActionRetries;
writeFileSync(reportPath, `${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify({event:'evaluation-complete',reportPath,...report,runs:results.map(({pairsData,...row})=>row)},null,2));
