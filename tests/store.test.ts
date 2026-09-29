import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ArenaStore } from '../src/store.js';
import type { MatchPrivate, MatchResult, MatchSummary } from '../src/contracts.js';

const agent = (id: string, version = '1'): MatchSummary['p1'] => ({ id, name: id, version, configHash: `hash-${id}` });
const summary = (id: string, mode: MatchSummary['mode'] = 'ranked'): MatchSummary => ({ id, groupId: null, formatId: 'format', engineVersion: 'engine', mode, status: 'running', p1: agent('a'), p2: agent('b'), winner: null, reason: null, turn: 0, startedAt: new Date().toISOString(), endedAt: null });
const metadata: MatchPrivate = { seed: [1, 2, 3, 4], policySeeds: { p1: 5, p2: 6 }, agents: { p1: { ...agent('a'), command: 'a', args: [], cwd: '.', config: {}, configHash: 'hash-a' }, p2: { ...agent('b'), command: 'b', args: [], cwd: '.', config: {}, configHash: 'hash-b' } }, limits: { startupMs: 1, decisionMs: 1, totalDecisionMs: 1, matchMs: 1 } };
const result = (winner: MatchResult['winner'] = 'p1'): MatchResult => ({ status: 'completed', winner, reason: 'done', turn: 2, teams: [['team']], inputLog: ['>start {}'] });

function withStore(run: (store: ArenaStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'showdown-store-'));
  const path = join(dir, 'arena.sqlite');
  const store = new ArenaStore(path);
  try { run(store); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('persists public records and turn markers', () => withStore(store => {
  store.createMatch(summary('m'), metadata);
  const record = store.appendRecord('m', { kind: 'public', turn: 0, at: new Date().toISOString(), data: '|turn|3' });
  assert.equal(record.seq, 1);
  assert.equal(store.getMatch('m')?.turn, 3);
  assert.deepEqual(store.getRecords('m')[0], record);
}));

test('finish is idempotent and applies Elo once', () => withStore(store => {
  store.createMatch(summary('m'), metadata);
  const first = store.finishMatch('m', result('p1'));
  const second = store.finishMatch('m', result('p2'));
  assert.deepEqual(second, first);
  const rows = store.leaderboard();
  assert.equal(rows.find(row => row.id === 'a')?.games, 1);
  assert.equal(rows.find(row => row.id === 'a')?.rating, 1016);
  assert.equal(rows.find(row => row.id === 'b')?.rating, 984);
  assert.equal(rows.find(row => row.id === 'b')?.games, 1);
}));

test('unranked and recovered matches do not create ratings', () => withStore(store => {
  store.createMatch(summary('u', 'unranked'), metadata);
  store.finishMatch('u', result('p1'));
  assert.deepEqual(store.leaderboard(), []);
  store.createMatch(summary('r'), metadata);
  store.recover();
  assert.equal(store.getMatch('r')?.status, 'interrupted');
  assert.deepEqual(store.leaderboard(), []);
}));
