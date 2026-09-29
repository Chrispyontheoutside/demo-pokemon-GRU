#!/usr/bin/env node
// Behavioral analysis of trained M-C policies: are they learning structure beyond mimicking the heuristic they train against?
//
//   node scripts/analyze-battles.mjs --checkpoints name=policy.json,name2=policy.json [--reference name=initial.json,...]
//                                    [--pairs 60] [--out runs/champions-vgc-2026-reg-mc/analysis]
//
// Every analysis plays FRESH battles (seed block advances each run, disjoint from training 2.0e9 and evaluation 3.x e9 ranges),
// each pair with the learner in both seats against the fixed heuristic. Measured, per checkpoint:
//   winRate         vs heuristic on these fresh battles
//   heuristicAgree  how often the sampled/argmax action equals the heuristic's own choice for the same state
//   memory          (recurrent only) causal test: action-distribution change and win-rate change when the carried hidden state
//                   is zeroed at every decision. A recurrent net that ignores history shows ~0 on both.
//   foresight       AUC of the critic's predicted value against the final result, by how early in the game it is asked
//   tactics         situational rates read from the simulator request: Protect vs HP, switching at low HP, first-turn
//                   support/speed-control moves, focus fire on one foe, Mega usage - for the learner AND the heuristic
// These are behavioral proxies for strategic structure, not proof of "reasoning". Untrained reference weights of the same
// architecture are analysed on identical battles as the chance control.
import {existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import showdown from 'pokemon-showdown';
import {Policy, play} from '../dist/src/champions-worker.js';
import {heuristic} from '../dist/src/champions.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const parseList = text => text ? text.split(',').filter(Boolean).map(item => { const at = item.indexOf('='); return [item.slice(0, at), item.slice(at + 1)]; }) : [];
const checkpoints = parseList(opt('--checkpoints'));
const references = parseList(opt('--reference'));
const pairs = Number(opt('--pairs', 60));
const outDir = opt('--out', 'runs/champions-vgc-2026-reg-mc/analysis');
if (!checkpoints.length) throw new Error('--checkpoints name=path[,name=path...] is required');
mkdirSync(outDir, {recursive: true});
const statePath = join(outDir, 'state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {runs: 0};
const seedBase = 4000000000 + state.runs * 1000;
const prng = n => { const rng = new showdown.PRNG(`41,53,${(n >>> 16) & 65535},${n & 65535}`); return () => rng.random(); };

const PROTECT = new Set(['protect', 'detect', 'kingsshield', 'spikyshield', 'banefulbunker', 'obstruct', 'silktrap', 'burningbulwark', 'endure']);
const SUPPORT_FIRST = new Set(['fakeout', 'tailwind', 'trickroom', 'helpingHand', 'helpinghand', 'followme', 'ragepowder', 'icywind', 'electroweb']);
const hpFraction = pokemon => { const [cur, max] = String(pokemon?.condition ?? '0/1').split(' ')[0].split('/').map(Number); return max ? cur / max : 0; };
const newTactics = () => ({slotDecisions: 0, moves: 0, protect: 0, protectLowHp: 0, movesLowHp: 0, protectHighHp: 0, movesHighHp: 0,
  switches: 0, switchLowHp: 0, slotsLowHp: 0, firstTurnSlots: 0, firstTurnSupport: 0, twoTargetDecisions: 0, sameTarget: 0,
  megaAvailable: 0, megaUsed: 0, decisions: 0});
function tally(tactics, request, choice, firstBattleDecision) {
  if (!request?.active) return;
  tactics.decisions++;
  const parts = choice.split(',').map(part => part.trim());
  const targets = [];
  parts.forEach((part, slot) => {
    const active = request.active[slot];
    if (!active || part === 'pass') return;
    const tokens = part.split(/\s+/);
    tactics.slotDecisions++;
    const hp = hpFraction(request.side.pokemon[slot]);
    if (hp < 0.3 && tokens[0] !== 'pass') tactics.slotsLowHp++;
    if (tokens[0] === 'switch') { tactics.switches++; if (hp < 0.3) tactics.switchLowHp++; return; }
    if (tokens[0] !== 'move') return;
    const move = active.moves?.[Number(tokens[1]) - 1];
    if (!move) return;
    tactics.moves++;
    const isProtect = PROTECT.has(move.id);
    if (hp < 0.4) { tactics.movesLowHp++; tactics.protectLowHp += isProtect; }
    if (hp > 0.7) { tactics.movesHighHp++; tactics.protectHighHp += isProtect; }
    tactics.protect += isProtect;
    if (firstBattleDecision) { tactics.firstTurnSlots++; tactics.firstTurnSupport += SUPPORT_FIRST.has(move.id); }
    const target = Number(tokens[2]);
    if (Number.isFinite(target) && target > 0 && !isProtect && move.target === 'normal') targets.push(target);
    if (tokens.includes('mega')) tactics.megaUsed++;
    if (active.canMegaEvo) tactics.megaAvailable++;
  });
  if (targets.length === 2) { tactics.twoTargetDecisions++; tactics.sameTarget += targets[0] === targets[1]; }
}
const rate = (a, b) => b ? a / b : null;
const tacticSummary = t => ({decisions: t.decisions, protectRate: rate(t.protect, t.moves), protectRateLowHp: rate(t.protectLowHp, t.movesLowHp),
  protectRateHighHp: rate(t.protectHighHp, t.movesHighHp), switchRate: rate(t.switches, t.slotDecisions),
  switchRateLowHp: rate(t.switchLowHp, t.slotsLowHp), firstTurnSupportRate: rate(t.firstTurnSupport, t.firstTurnSlots),
  focusFireRate: rate(t.sameTarget, t.twoTargetDecisions), megaUseWhenAvailable: rate(t.megaUsed, t.megaAvailable),
  samples: {movesLowHp: t.movesLowHp, movesHighHp: t.movesHighHp, slotsLowHp: t.slotsLowHp, twoTarget: t.twoTargetDecisions, firstTurn: t.firstTurnSlots}});

function auc(values, labels) {
  const positives = labels.filter(Boolean).length, negatives = labels.length - positives;
  if (!positives || !negatives) return null;
  const order = values.map((value, i) => [value, labels[i]]).sort((a, b) => a[0] - b[0]);
  let rankSum = 0;
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (order[k][1]) rankSum += rank;
    i = j + 1;
  }
  return (rankSum - positives * (positives + 1) / 2) / (positives * negatives);
}
const wilson = (wins, n) => { if (!n) return null; const z = 1.96, p = wins / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return [c - h, c + h]; };
const bucketOf = index => index === 0 ? 'teamPreview' : index <= 2 ? 'early(1-2)' : index <= 4 ? 'mid(3-4)' : 'late(5+)';

async function analyse(name, path) {
  const raw = readFileSync(path);
  const checkpoint = JSON.parse(raw);
  const policy = new Policy(checkpoint);
  const recurrent = checkpoint.modelArchitecture === 'candidate-conditioned-gru-v1';
  const learnerTactics = newTactics(), heuristicTactics = newTactics();
  const foresight = {}; const entropyByBucket = {};
  let decisions = 0, agreeSampled = 0, agreeArgmax = 0, tvSum = 0, argmaxChanged = 0, wins = 0, games = 0, winsAblated = 0, gamesAblated = 0;

  async function game(seed, learnerSide, ablate, record) {
    const rng = {p1: prng(seed * 2), p2: prng(seed * 2 + 1)};
    const firstSeen = {p1: false, p2: false};
    const indexOf = {p1: 0, p2: 0};
    const pending = [];
    const result = await play(seed, (side, encoded, hidden, request) => {
      const battle = Boolean(request?.active);
      const first = battle && !firstSeen[side];
      if (battle) firstSeen[side] = true;
      const heuristicAction = heuristic(encoded);
      if (side !== learnerSide) {
        const choice = encoded.candidates[heuristicAction].choice;
        if (record) tally(heuristicTactics, request, choice, first);
        return {action: heuristicAction, logp: 0, value: 0, choice};
      }
      const prediction = policy.predict(encoded, undefined, ablate ? undefined : hidden);
      let threshold = rng[side](), action = prediction.probabilities.length - 1;
      for (let i = 0; i < prediction.probabilities.length; i++) { threshold -= prediction.probabilities[i]; if (threshold < 0) { action = i; break; } }
      const choice = encoded.candidates[action].choice;
      if (record) {
        const argmax = prediction.probabilities.indexOf(Math.max(...prediction.probabilities));
        decisions++; agreeSampled += action === heuristicAction; agreeArgmax += argmax === heuristicAction;
        tally(learnerTactics, request, choice, first);
        const bucket = bucketOf(indexOf[side]);
        (entropyByBucket[bucket] ??= []).push(prediction.entropy);
        pending.push({bucket, value: prediction.value});
        if (recurrent && !ablate) {
          const zero = policy.predict(encoded, undefined, undefined);
          tvSum += 0.5 * prediction.probabilities.reduce((n, p, i) => n + Math.abs(p - zero.probabilities[i]), 0);
          argmaxChanged += zero.probabilities.indexOf(Math.max(...zero.probabilities)) !== argmax;
        }
      }
      indexOf[side]++;
      return {action, logp: 0, value: prediction.value, entropy: prediction.entropy, nextHidden: prediction.hidden, choice};
    });
    const won = result.winner === learnerSide;
    if (record) for (const item of pending) (foresight[item.bucket] ??= {values: [], labels: []}, foresight[item.bucket].values.push(item.value), foresight[item.bucket].labels.push(won));
    return won;
  }
  for (let pair = 0; pair < pairs; pair++) {
    const seed = seedBase + pair;
    for (const side of ['p1', 'p2']) { wins += await game(seed, side, false, true); games++; }
    if (recurrent) for (const side of ['p1', 'p2']) { winsAblated += await game(seed, side, true, false); gamesAblated++; }
  }
  const mean = values => values?.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return {
    name, path, sha256: createHash('sha256').update(raw).digest('hex'), architecture: checkpoint.modelArchitecture,
    trainingBattles: (checkpoint.selfPlayBattlesUsedForPPO ?? 0) + (checkpoint.baselineTrainingBattlesUsedForPPO ?? 0),
    decisionsTrained: checkpoint.steps,
    winRate: {wins, games, rate: wins / games, ci95: wilson(wins, games)},
    heuristicAgree: {decisions, sampled: rate(agreeSampled, decisions), argmax: rate(agreeArgmax, decisions)},
    memory: recurrent ? {tvDistanceVsZeroedMemory: rate(tvSum, decisions), argmaxChangeRate: rate(argmaxChanged, decisions),
      winRateIntact: wins / games, winRateMemoryZeroed: winsAblated / gamesAblated, winRateDelta: wins / games - winsAblated / gamesAblated,
      ablatedGames: gamesAblated} : null,
    foresightAUC: Object.fromEntries(Object.entries(foresight).map(([bucket, data]) => [bucket, {auc: auc(data.values, data.labels), n: data.values.length}])),
    entropy: Object.fromEntries(Object.entries(entropyByBucket).map(([bucket, values]) => [bucket, mean(values)])),
    tactics: {learner: tacticSummary(learnerTactics), heuristic: tacticSummary(heuristicTactics)},
  };
}

const started = Date.now();
const entries = [], referenceEntries = [];
for (const [name, path] of references) referenceEntries.push(await analyse(`ref:${name}`, path));
for (const [name, path] of checkpoints) entries.push(await analyse(name, path));
const report = {analysisId: state.runs, generatedAt: new Date().toISOString(), seedBase, pairsPerCheckpoint: pairs,
  seedBlock: `${seedBase}..${seedBase + pairs - 1}`, elapsedSeconds: (Date.now() - started) / 1000, entries, references: referenceEntries,
  caveat: 'Behavioral proxies on fresh battles vs the fixed heuristic; small samples per analysis, read trends across analyses, not single values.'};
const stamp = report.generatedAt.replaceAll(':', '-');
writeFileSync(join(outDir, `latent-${String(state.runs).padStart(4, '0')}-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
const brief = e => ({name: e.name, sha: e.sha256.slice(0, 12), arch: e.architecture, trainingBattles: e.trainingBattles, winRate: e.winRate.rate,
  agreeArgmax: e.heuristicAgree.argmax, memoryWinDelta: e.memory?.winRateDelta ?? null, memoryTV: e.memory?.tvDistanceVsZeroedMemory ?? null,
  aucEarly: e.foresightAUC['early(1-2)']?.auc ?? null, aucMid: e.foresightAUC['mid(3-4)']?.auc ?? null,
  protectLow: e.tactics.learner.protectRateLowHp, protectHigh: e.tactics.learner.protectRateHighHp, switchLow: e.tactics.learner.switchRateLowHp,
  focusFire: e.tactics.learner.focusFireRate, firstTurnSupport: e.tactics.learner.firstTurnSupportRate,
  heuristicFocusFire: e.tactics.heuristic.focusFireRate, heuristicProtectLow: e.tactics.heuristic.protectRateLowHp});
appendFileSync(join(outDir, 'latent-reasoning.jsonl'), `${JSON.stringify({analysisId: state.runs, at: report.generatedAt, seedBase, pairs, entries: [...referenceEntries, ...entries].map(brief)})}\n`);
writeFileSync(statePath, JSON.stringify({runs: state.runs + 1}));
const f = (v, d = 3) => v === null || v === undefined ? '—' : Number(v).toFixed(d);
console.log(`analysis #${state.runs}  seeds ${report.seedBlock}  ${report.elapsedSeconds.toFixed(0)}s`);
console.log('| policy | battles | win vs heur | agree(argmax) | mem ΔWR | mem TV | AUC early | AUC mid | focus fire (heur) | protect lowHP/highHP (heur lowHP) | switch lowHP | 1st-turn support |');
console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|');
for (const e of [...referenceEntries, ...entries]) {
  const t = e.tactics.learner, h = e.tactics.heuristic;
  console.log(`| ${e.name} | ${e.trainingBattles} | ${f(e.winRate.rate)} | ${f(e.heuristicAgree.argmax)} | ${f(e.memory?.winRateDelta)} | ${f(e.memory?.tvDistanceVsZeroedMemory)} | ${f(e.foresightAUC['early(1-2)']?.auc)} | ${f(e.foresightAUC['mid(3-4)']?.auc)} | ${f(t.focusFireRate)} (${f(h.focusFireRate)}) | ${f(t.protectRateLowHp, 2)}/${f(t.protectRateHighHp, 2)} (${f(h.protectRateLowHp, 2)}) | ${f(t.switchRateLowHp, 2)} | ${f(t.firstTurnSupportRate, 2)} |`);
}
