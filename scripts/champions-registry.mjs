#!/usr/bin/env node
// Permanent checkpoint / ladder-milestone registry for the Champions VGC Reg M-C project.
//
//   register <policy.json> [--lineage <sha>] [--training-opponent heuristic] [--throughput <battles/sec>]
//            [--architecture-notes "..."] [--mix heuristic=0.7,selfplay=0.3] [--pool]
//   local-eval <sha|prefix> <evaluation-report.json>        attach fixed-suite / historical-agent scores (hash-verified)
//   ingest-ladder <summary.json ...>                         attach real ladder sessions (matched by checkpoint hash)
//   milestones                                                verify thresholds, freeze first credible checkpoint per milestone
//   verify                                                    re-hash every frozen file
//   status                                                    tables for humans / STATUS.md
//   show <sha|prefix>                                         full record
//
// Frozen files are immutable copies keyed by SHA-256 and made read-only. Nothing here is specific to 1200:
// the milestone ladder is data (milestones.json) and extends by 100 Elo beyond its last entry.
import {chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {basename, dirname, join, resolve} from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const DIR = process.env.CHAMPIONS_REGISTRY_DIR ?? join(ROOT, 'runs/champions-vgc-2026-reg-mc/registry');
const FORMAT = 'gen9championsvgc2026regmc';
const DEFAULT_RULES = {
  thresholds: [1000, 1050, 1100, 1150, 1200, 1250, 1300, 1400, 1500],
  extendBeyondLastByElo: 100,
  // A milestone is credible only after sustained play, not a touch: enough rated games, final rating at/above the
  // threshold, and the mean post-game rating over the most recent window at/above the threshold too.
  minRatedGames: 50, sustainedWindow: 25, requireFinalAtOrAbove: true, requireWindowMeanAtOrAbove: true,
};
const sha256 = data => createHash('sha256').update(data).digest('hex');
const now = () => new Date().toISOString();
const die = message => { console.error(message); process.exit(1); };

mkdirSync(join(DIR, 'frozen'), {recursive: true});
mkdirSync(join(DIR, 'milestones'), {recursive: true});
const registryPath = join(DIR, 'registry.json');
const milestonesPath = join(DIR, 'milestones.json');
const load = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
const save = (path, value) => { const tmp = `${path}.tmp`; writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`); renameSync(tmp, path); };
const registry = load(registryPath, {format: FORMAT, checkpoints: {}});
const milestones = load(milestonesPath, {format: FORMAT, rules: DEFAULT_RULES, achieved: {}});
milestones.rules = {...DEFAULT_RULES, ...milestones.rules};

function resolveSha(prefix) {
  const matches = Object.keys(registry.checkpoints).filter(sha => sha.startsWith(prefix));
  if (matches.length !== 1) die(`Checkpoint prefix "${prefix}" matched ${matches.length} registry entries`);
  return matches[0];
}
const paramCount = weights => Object.values(weights).reduce((n, tensor) => n + [tensor].flat(Infinity).length, 0);
const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const pct = value => value === undefined || value === null ? '—' : `${(100 * value).toFixed(1)}%`;

function register(args) {
  const path = args.find(arg => !arg.startsWith('--') && arg !== flag(args, '--lineage') && arg !== flag(args, '--training-opponent') &&
    arg !== flag(args, '--throughput') && arg !== flag(args, '--mix') && arg !== flag(args, '--architecture-notes'));
  if (!path || !existsSync(path)) die('register needs an existing policy.json path');
  const raw = readFileSync(path);
  const sha = sha256(raw);
  const checkpoint = JSON.parse(raw);
  if (checkpoint.format !== FORMAT) die(`Checkpoint format ${checkpoint.format} is not ${FORMAT}`);
  const existing = registry.checkpoints[sha];
  const frozenPath = join(DIR, 'frozen', sha.slice(0, 12), 'policy.json');
  if (!existsSync(frozenPath)) {
    mkdirSync(dirname(frozenPath), {recursive: true});
    copyFileSync(path, frozenPath);
    chmodSync(frozenPath, 0o444);
  }
  const sibling = name => { const file = join(dirname(path), name); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined; };
  const stem = basename(path).replace(/(-\d+)?\.json$/, '');
  const status = sibling(`${stem}.status.json`);
  const training = sibling(`${stem}.training.json`);
  const selfplay = Number(checkpoint.selfPlayBattlesUsedForPPO ?? 0);
  const baseline = Number(checkpoint.baselineTrainingBattlesUsedForPPO ?? 0);
  const total = selfplay + baseline;
  const opponent = flag(args, '--training-opponent') ?? training?.trainingOpponent ?? (baseline ? 'heuristic' : selfplay ? 'selfplay' : 'unknown');
  const counts = checkpoint.trainingOpponentBattles && Object.keys(checkpoint.trainingOpponentBattles).length ? checkpoint.trainingOpponentBattles : null;
  const countedTotal = counts ? Object.values(counts).reduce((n, v) => n + Number(v), 0) : 0;
  const mix = counts && !flag(args, '--mix')
    ? Object.fromEntries(Object.entries(counts).map(([kind, n]) => [kind, Number(n) / countedTotal]))
    : flag(args, '--mix')
    ? Object.fromEntries(flag(args, '--mix').split(',').map(entry => { const [k, v] = entry.split('='); return [k, Number(v)]; }))
    : total ? {[opponent === 'selfplay' ? 'selfplay' : opponent]: baseline / total, ...(selfplay ? {selfplay: selfplay / total} : {})} : {};
  const record = {
    sha256: sha, frozenPath: frozenPath.replace(`${ROOT}/`, ''), sourcePath: path, registeredAt: existing?.registeredAt ?? now(),
    architecture: checkpoint.modelArchitecture ?? 'legacy', parameters: paramCount(checkpoint.weights),
    stateDim: checkpoint.stateDim, actionDim: checkpoint.actionDim, engineVersion: checkpoint.engineVersion,
    teamGeneratorVersion: checkpoint.teamGeneratorVersion,
    decisions: checkpoint.steps,
    training: {
      battlesTotal: total, battlesVsHeuristicOrBaseline: baseline, battlesSelfPlay: selfplay,
      opponentDistribution: mix, selfPlayPercent: total ? 100 * selfplay / total : 0, trainingOpponent: opponent,
      opponentBattlesByKind: counts,
      initialization: checkpoint.initialization,
      throughputBattlesPerSecond: flag(args, '--throughput') ? Number(flag(args, '--throughput')) : (status?.trainingBattlesPerSecond ?? existing?.training?.throughputBattlesPerSecond ?? null),
      workers: status?.workers ?? null,
    },
    lineageParent: flag(args, '--lineage') ? resolveSha(flag(args, '--lineage')) : existing?.lineageParent ?? null,
    notes: flag(args, '--architecture-notes') ?? existing?.notes ?? '',
    opponentPool: args.includes('--pool') || existing?.opponentPool || false,
    local: existing?.local ?? null, vsHistory: existing?.vsHistory ?? [],
    ladder: existing?.ladder ?? {sessions: [], history: [], gamesPlayed: 0, ratedGames: 0, wins: 0, losses: 0, ties: 0, first: null, peak: null, final: null},
  };
  registry.checkpoints[sha] = record;
  save(registryPath, registry);
  console.log(`${existing ? 'updated' : 'registered'} ${sha.slice(0, 12)} ${record.architecture} ${record.parameters} params, ${total} training battles (${record.training.selfPlayPercent.toFixed(0)}% self-play) -> ${record.frozenPath}`);
  return sha;
}

function localEval(args) {
  const [prefix, reportPath] = args;
  if (!prefix || !reportPath) die('local-eval needs <sha> <report.json>');
  const sha = resolveSha(prefix);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (report.checkpointSHA256 !== sha) die(`Report ${reportPath} evaluated ${String(report.checkpointSHA256).slice(0, 12)}, not ${sha.slice(0, 12)}`);
  const row = name => report.runs.find(run => run.baseline === name);
  const summary = run => run && ({score: run.score, ci95: run.paired95ci, battles: run.battles, wins: run.wins, losses: run.losses});
  const record = registry.checkpoints[sha];
  const at = {report: reportPath, seed: report.seed, pairs: report.pairsPerBaseline, evaluatedAt: now()};
  if (row('random') || row('heuristic')) {
    record.local = {...at, vsRandom: summary(row('random')), vsHeuristic: summary(row('heuristic')),
      hiddenTrapReveals: report.hiddenTrapReveals, illegalActionRetries: report.illegalActionRetries, truncated: report.truncated, aborted: report.aborted};
  }
  if (row('frozen')) {
    const opponent = report.frozenOpponentSHA256;
    record.vsHistory = record.vsHistory.filter(entry => !(entry.opponentSha256 === opponent && entry.seed === report.seed));
    record.vsHistory.push({...at, opponentSha256: opponent, ...summary(row('frozen'))});
  }
  save(registryPath, registry);
  console.log(`attached ${basename(reportPath)} to ${sha.slice(0, 12)}: vs random ${pct(record.local?.vsRandom?.score)}, vs heuristic ${pct(record.local?.vsHeuristic?.score)}, ${record.vsHistory.length} historical opponents`);
}

// How a ladder game ended, from the battle log: a win by opponent forfeit/timer says little about play strength.
function classifyEnding(sessionFile, result) {
  try {
    const log = readFileSync(join(dirname(sessionFile), `${result.room}.log`), 'utf8');
    const abnormal = /\|-message\|.* forfeited\.|lost due to inactivity/.test(log);
    if (!abnormal) return 'normal';
    const timer = /lost due to inactivity/.test(log);
    if (result.turns <= 2) return timer ? 'timer-early' : 'forfeit-early';
    return timer ? 'timer-substantial' : 'forfeit-substantial';
  } catch { return 'unknown'; }
}
// A summary can lack ratingAfter (the adapter once failed to match hyphenated names); the server's own log line is authoritative.
function ratingFromLog(sessionFile, result, accountName) {
  try {
    const log = readFileSync(join(dirname(sessionFile), `${result.room}.log`), 'utf8');
    const own = String(accountName).toLowerCase().replace(/[^a-z0-9]/g, '');
    let rating = null;
    for (const line of log.split('\n')) {
      const m = /^\|raw\|(.*?)'s rating: \d+ &rarr; <strong>(\d+)<\/strong>/.exec(line);
      if (m && m[1].toLowerCase().replace(/[^a-z0-9]/g, '') === own) rating = Number(m[2]);
    }
    return rating;
  } catch { return null; }
}
const userid = name => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
function ingestLadder(files) {
  if (!files.length) die('ingest-ladder needs summary.json paths');
  for (const file of files.sort()) {
    const summary = JSON.parse(readFileSync(file, 'utf8'));
    const sha = summary.checkpointSHA256;
    if (!registry.checkpoints[sha]) {
      const source = summary.checkpointPath && existsSync(join(ROOT, summary.checkpointPath)) ? join(ROOT, summary.checkpointPath) : undefined;
      if (!source || sha256(readFileSync(source)) !== sha) { console.warn(`skip ${file}: checkpoint ${String(sha).slice(0, 12)} is not registered and its file is unavailable`); continue; }
      register([source]);
    }
    const ladder = registry.checkpoints[sha].ladder;
    const me = userid(summary.name);
    for (const result of summary.results) {
      if (!['win', 'loss', 'tie'].includes(result.outcome)) continue;
      const opponent = Object.values(result.players ?? {}).find(name => userid(name) !== me);
      ladder.history.push({room: result.room, session: file, outcome: result.outcome, opponent,
        ratingBefore: result.ratingsAtBattleStart?.[me] ?? null, ratingAfter: result.ratingAfter ?? ratingFromLog(file, result, summary.name),
        opponentRatingBefore: result.ratingsAtBattleStart?.[userid(opponent)] ?? null, turns: result.turns,
        ending: classifyEnding(file, result)});
    }
    if (!ladder.sessions.includes(file)) ladder.sessions.push(file);   // games are de-duplicated by room, so re-ingesting a growing session is safe
    ladder.history = [...new Map(ladder.history.map(entry => [entry.room, entry])).values()];
  }
  for (const record of Object.values(registry.checkpoints)) {
    const ladder = record.ladder;
    ladder.gamesPlayed = ladder.history.length;
    ladder.wins = ladder.history.filter(g => g.outcome === 'win').length;
    ladder.losses = ladder.history.filter(g => g.outcome === 'loss').length;
    ladder.ties = ladder.history.filter(g => g.outcome === 'tie').length;
    const abnormalWin = g => g.outcome === 'win' && g.ending !== 'normal' && g.ending !== 'unknown';
    ladder.endingsOfWins = Object.fromEntries([...new Set(ladder.history.filter(g => g.outcome === 'win').map(g => g.ending))]
      .map(kind => [kind, ladder.history.filter(g => g.outcome === 'win' && g.ending === kind).length]));
    // "Genuine" record: drop wins that ended in an early forfeit or timer (opponent left); substantial-play forfeits are kept but reported.
    const excluded = g => g.outcome === 'win' && ['forfeit-early', 'timer-early', 'timer-substantial'].includes(g.ending);
    ladder.genuineWins = ladder.history.filter(g => g.outcome === 'win' && !excluded(g)).length;
    ladder.genuineGames = ladder.history.filter(g => !excluded(g)).length;
    const rated = ladder.history.filter(g => Number.isFinite(g.ratingAfter));
    ladder.ratedGames = rated.length;
    const points = ladder.history.flatMap(g => [g.ratingBefore, g.ratingAfter]).filter(Number.isFinite);
    ladder.first = ladder.history.find(g => Number.isFinite(g.ratingBefore))?.ratingBefore ?? null;
    ladder.peak = points.length ? Math.max(...points) : null;
    ladder.final = rated.length ? rated[rated.length - 1].ratingAfter : null;
  }
  save(registryPath, registry);
  for (const [sha, record] of Object.entries(registry.checkpoints)) if (record.ladder.gamesPlayed)
    console.log(`${sha.slice(0, 12)}: ${record.ladder.gamesPlayed} games ${record.ladder.wins}-${record.ladder.losses}-${record.ladder.ties} (genuine ${record.ladder.genuineWins}-${record.ladder.genuineGames - record.ladder.genuineWins}, wins by ending ${JSON.stringify(record.ladder.endingsOfWins)}), rated ${record.ladder.ratedGames}, final ${record.ladder.final ?? '—'}, peak ${record.ladder.peak ?? '—'}`);
}

function thresholdList() {
  const {thresholds, extendBeyondLastByElo} = milestones.rules;
  const peak = Math.max(0, ...Object.values(registry.checkpoints).map(r => r.ladder.peak ?? 0));
  const list = [...thresholds];
  while (list[list.length - 1] < peak + extendBeyondLastByElo) list.push(list[list.length - 1] + extendBeyondLastByElo);
  return list;
}
function credibility(record, threshold) {
  const {minRatedGames, sustainedWindow} = milestones.rules;
  const rated = record.ladder.history.filter(g => Number.isFinite(g.ratingAfter));
  const window = rated.slice(-sustainedWindow).map(g => g.ratingAfter);
  const mean = window.length ? window.reduce((a, b) => a + b, 0) / window.length : null;
  const finalOk = record.ladder.final !== null && record.ladder.final >= threshold;
  const meanOk = mean !== null && window.length >= Math.min(sustainedWindow, minRatedGames) && mean >= threshold;
  const enough = rated.length >= minRatedGames;
  return {ratedGames: rated.length, enough, finalOk, windowMean: mean, meanOk, verified: enough && finalOk && meanOk,
    provisional: !enough && finalOk};
}
function checkMilestones() {
  for (const threshold of thresholdList()) {
    const key = String(threshold);
    const candidates = Object.values(registry.checkpoints).filter(r => credibility(r, threshold).verified)
      .sort((a, b) => (a.ladder.history.at(-1)?.session ?? '').localeCompare(b.ladder.history.at(-1)?.session ?? ''));
    if (!milestones.achieved[key] && candidates.length) {
      const record = candidates[0];
      const target = join(DIR, 'milestones', `elo-${threshold}`, 'policy.json');
      mkdirSync(dirname(target), {recursive: true});
      copyFileSync(resolve(ROOT, record.frozenPath), target);
      chmodSync(target, 0o444);
      milestones.achieved[key] = {threshold, sha256: record.sha256, verifiedAt: now(), path: target.replace(`${ROOT}/`, ''),
        finalRating: record.ladder.final, peakRating: record.ladder.peak, ratedGames: record.ladder.ratedGames,
        record: `${record.ladder.wins}-${record.ladder.losses}-${record.ladder.ties}`, architecture: record.architecture,
        parameters: record.parameters, trainingBattles: record.training.battlesTotal};
      console.log(`MILESTONE ${threshold} verified and frozen: ${record.sha256.slice(0, 12)} (${record.ladder.ratedGames} rated games, final ${record.ladder.final})`);
    }
  }
  save(milestonesPath, milestones);
}

function verify() {
  let bad = 0;
  for (const record of Object.values(registry.checkpoints)) {
    const ok = existsSync(resolve(ROOT, record.frozenPath)) && sha256(readFileSync(resolve(ROOT, record.frozenPath))) === record.sha256;
    if (!ok) { bad++; console.error(`HASH MISMATCH or missing: ${record.frozenPath}`); }
  }
  for (const item of Object.values(milestones.achieved)) {
    const ok = existsSync(resolve(ROOT, item.path)) && sha256(readFileSync(resolve(ROOT, item.path))) === item.sha256;
    if (!ok) { bad++; console.error(`MILESTONE HASH MISMATCH or missing: ${item.path}`); }
  }
  console.log(bad ? `${bad} problem(s)` : `all ${Object.keys(registry.checkpoints).length} frozen checkpoints and ${Object.keys(milestones.achieved).length} milestones verified`);
  process.exit(bad ? 1 : 0);
}

function status() {
  console.log('| Milestone | State | Checkpoint | Final / peak | Rated games | W-L | Window mean |\n|---:|---|---|---|---:|---|---:|');
  for (const threshold of thresholdList()) {
    const done = milestones.achieved[String(threshold)];
    const best = Object.values(registry.checkpoints).map(r => ({r, c: credibility(r, threshold)})).filter(x => x.c.finalOk || x.c.verified)
      .sort((a, b) => (b.r.ladder.final ?? 0) - (a.r.ladder.final ?? 0))[0];
    if (done) console.log(`| ${threshold} | **frozen** | \`${done.sha256.slice(0, 12)}\` | ${done.finalRating} / ${done.peakRating} | ${done.ratedGames} | ${done.record} | — |`);
    else if (best?.c.provisional) console.log(`| ${threshold} | provisional (${best.c.ratedGames}/${milestones.rules.minRatedGames} rated games) | \`${best.r.sha256.slice(0, 12)}\` | ${best.r.ladder.final} / ${best.r.ladder.peak} | ${best.c.ratedGames} | ${best.r.ladder.wins}-${best.r.ladder.losses} | ${best.c.windowMean?.toFixed(0) ?? '—'} |`);
    else console.log(`| ${threshold} | not reached | — | — | — | — | — |`);
  }
  console.log('\n| Checkpoint | Architecture | Params | Training battles | Self-play | Opponents | vs random | vs heuristic | vs history (n) | Battles/s | Ladder final / peak | Rated | W-L-T |\n|---|---|---:|---:|---:|---|---:|---:|---:|---:|---|---:|---|');
  for (const r of Object.values(registry.checkpoints)) {
    const history = r.vsHistory.length ? `${pct(r.vsHistory.reduce((s, h) => s + h.score, 0) / r.vsHistory.length)} (${r.vsHistory.length})` : '—';
    const mix = Object.entries(r.training.opponentDistribution).map(([k, v]) => `${k} ${(100 * v).toFixed(0)}%`).join(', ') || '—';
    console.log(`| \`${r.sha256.slice(0, 12)}\` | ${r.architecture} | ${r.parameters} | ${r.training.battlesTotal} | ${r.training.selfPlayPercent.toFixed(0)}% | ${mix} | ${pct(r.local?.vsRandom?.score)} | ${pct(r.local?.vsHeuristic?.score)} | ${history} | ${r.training.throughputBattlesPerSecond ?? '—'} | ${r.ladder.final ?? '—'} / ${r.ladder.peak ?? '—'} | ${r.ladder.ratedGames} | ${r.ladder.wins}-${r.ladder.losses}-${r.ladder.ties} |`);
  }
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'register': register(args); break;
  case 'local-eval': localEval(args); break;
  case 'ingest-ladder': ingestLadder(args); checkMilestones(); break;
  case 'milestones': checkMilestones(); status(); break;
  case 'verify': verify(); break;
  case 'status': status(); break;
  case 'show': console.log(JSON.stringify(registry.checkpoints[resolveSha(args[0])], null, 2)); break;
  default: die('commands: register | local-eval | ingest-ladder | milestones | verify | status | show');
}
