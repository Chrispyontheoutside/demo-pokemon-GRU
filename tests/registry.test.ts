import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync, existsSync, statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const script = join(process.cwd(), 'scripts/champions-registry.mjs');
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'registry-test-'));
  const checkpoint = join(dir, 'policy.json');
  const body = JSON.stringify({schema: 1, format: 'gen9championsvgc2026regmc', engineVersion: 'x', modelArchitecture: 'candidate-conditioned-v3',
    stateDim: 800, actionDim: 56, steps: 10, selfPlayBattlesUsedForPPO: 25, baselineTrainingBattlesUsedForPPO: 75,
    weights: {'a.weight': [[1, 2], [3, 4]], 'a.bias': [0, 0]}});
  writeFileSync(checkpoint, body);
  const sha = createHash('sha256').update(body).digest('hex');
  const run = (...args: string[]) => execFileSync('node', [script, ...args], {env: {...process.env, CHAMPIONS_REGISTRY_DIR: join(dir, 'registry')}, encoding: 'utf8'});
  return {dir, checkpoint, sha, run};
}
function summary(dir: string, sha: string, name: string, ratings: number[], startAt = 1000) {
  let before = startAt;
  const results = ratings.map((after, i) => { const r = {room: `room-${name}-${i}`, players: {p1: 'Bot', p2: `Opp${i}`}, outcome: after >= before ? 'win' : 'loss',
    turns: 5, ratingsAtBattleStart: {bot: before}, ratingAfter: after}; before = after; return r; });
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify({name: 'Bot', checkpointSHA256: sha, checkpointPath: 'missing.json', results}));
  return path;
}

test('registry freezes checkpoints read-only, records training mix, and rejects mismatched evaluation reports', () => {
  const {dir, checkpoint, sha, run} = setup();
  run('register', checkpoint);
  const record = JSON.parse(run('show', sha.slice(0, 8)));
  assert.equal(record.parameters, 6);
  assert.equal(record.training.battlesTotal, 100);
  assert.equal(record.training.selfPlayPercent, 25);
  assert.equal(statSync(join(dir, 'registry/frozen', sha.slice(0, 12), 'policy.json')).mode & 0o222, 0);
  const report = join(dir, 'report.json');
  writeFileSync(report, JSON.stringify({checkpointSHA256: 'f'.repeat(64), runs: []}));
  assert.throws(() => execFileSync('node', [script, 'local-eval', sha.slice(0, 8), report], {env: {...process.env, CHAMPIONS_REGISTRY_DIR: join(dir, 'registry')}, stdio: 'pipe'}));
  assert.match(run('verify'), /verified/);
});

test('a milestone needs sustained rated play, not a single game at the threshold', () => {
  const {dir, checkpoint, sha, run} = setup();
  run('register', checkpoint);
  // Touches 1210 once after 10 games, then falls back: provisional only.
  const touch = summary(dir, sha, 'touch', [1005, 1010, 1020, 1030, 1050, 1080, 1120, 1170, 1210, 1180]);
  run('ingest-ladder', touch);
  assert.match(run('milestones'), /1200 \| not reached|1200 \| provisional/);
  assert.equal(existsSync(join(dir, 'registry/milestones/elo-1200/policy.json')), false);
  // A separate checkpoint that hovers above 1200 over 60 rated games earns the milestone.
  const other = setup();
  other.run('register', other.checkpoint);
  const sustained = summary(other.dir, other.sha, 'sustained', Array.from({length: 60}, (_, i) => 1000 + Math.min(i * 8, 230) + (i % 2)));
  const out = other.run('ingest-ladder', sustained);
  assert.match(out, /MILESTONE 1200 verified/);
  const frozen = join(other.dir, 'registry/milestones/elo-1200/policy.json');
  assert.equal(createHash('sha256').update(readFileSync(frozen)).digest('hex'), other.sha);
  assert.match(other.run('verify'), /5 milestones verified/);   // 1000, 1050, 1100, 1150 and 1200 are all sustained at ~1230
  assert.equal(existsSync(join(other.dir, 'registry/milestones/elo-1250/policy.json')), false);
  const info = JSON.parse(other.run('show', other.sha.slice(0, 8)));
  assert.equal(info.ladder.ratedGames, 60);
  assert.ok(info.ladder.peak >= 1200);
});
