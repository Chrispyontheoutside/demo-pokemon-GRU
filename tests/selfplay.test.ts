import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Policy} from '../src/gen6.js';
import {collect, evaluate} from '../src/train-worker.js';

test('self-play counts a battle once, trains both seats, and stores legal on-policy actions', async () => {
  const model = new Policy(JSON.parse(readFileSync('models/gen6-policy.json','utf8')));
  const batch = await collect(model, {steps: 10000, seed: 40000000, selfPlay: true, maxGames: 3});
  assert.equal(batch.completed, 3);
  assert.equal(batch.episodes.length, 6);
  assert.equal(batch.games, batch.completed + batch.discarded);
  assert.equal(batch.steps, batch.episodes.reduce((n, ep) => n + ep.steps.length, 0));
  for (let i=0; i<batch.episodes.length; i+=2) assert.equal(batch.episodes[i].reward + batch.episodes[i+1].reward, 0);
  for (const episode of batch.episodes) for (const row of episode.steps) {
    assert.ok(row.mask[row.action]);
    const prediction = model.predict({...row, candidates: []});
    assert.ok(Math.abs(Math.log(prediction.probabilities[row.action]) - row.logp) < 1e-8);
  }
});

test('frozen-model evaluation plays complementary seats and records all games', async () => {
  const model = new Policy(JSON.parse(readFileSync('models/gen6-policy.json','utf8')));
  const result = await evaluate(model, 3, 3100000000, model, 'original');
  assert.equal(result.opponent, 'original');
  assert.equal(result.pairScores.length, 3);
  assert.equal(result.wins + result.losses + result.draws, 6);
  assert.equal(result.truncated, 0);
});
