import test from 'node:test';
import assert from 'node:assert/strict';
import {DirectGame} from '../src/direct-battle.js';
import {makeTeam} from '../src/champions-worker.js';
import type {SideId} from '../src/champions.js';

/** Plays every pending side with a deterministic pick from its legal encoded candidates; returns the number of decisions made. */
function step(game: DirectGame, counter: {n: number}) {
  const sides = game.pending();
  for (const side of sides) {
    const encoded = game.encodeFor(side);
    let accepted = false;
    for (let attempt = 0; attempt < encoded.candidates.length && !accepted; attempt++) {
      const pick = (counter.n * 7 + attempt) % encoded.candidates.length;
      accepted = game.choose(side, encoded.candidates[pick].choice);
    }
    assert.ok(accepted, `no candidate accepted for ${side}`);
    counter.n++;
  }
  return sides.length;
}
const hp = (game: DirectGame) => JSON.stringify(game.battle.sides.map((side: any) => side.pokemon.map((mon: any) => mon.hp)));

test('DirectGame starts at team preview, plays to a winner, and mid-game clones replay identically', () => {
  const game = DirectGame.create([makeTeam([71, 89, 1, 2]), makeTeam([72, 89, 1, 2])], [17, 29, 1, 2]);
  assert.deepEqual(game.pending().sort(), ['p1', 'p2']);
  assert.ok(game.encodeFor('p1').candidates.length > 0);
  const counter = {n: 0};
  let turns = 0;
  while (!game.ended && turns < 4) { step(game, counter); turns++; }     // preview + a few turns
  assert.ok(!game.ended);
  const clone = game.clone();
  const counterOriginal = {n: counter.n}, counterClone = {n: counter.n};
  let guard = 0;
  while ((!game.ended || !clone.ended) && guard++ < 400) {
    if (!game.ended) step(game, counterOriginal);
    if (!clone.ended) step(clone, counterClone);
    assert.equal(hp(game), hp(clone), 'clone diverged from the original');
  }
  assert.ok(game.ended && clone.ended);
  assert.equal(game.winner, clone.winner);
  assert.ok(game.winner === 'p1' || game.winner === 'p2' || game.winner === null);
});

test('cloned views are independent of the original', () => {
  const game = DirectGame.create([makeTeam([71, 89, 3, 4]), makeTeam([72, 89, 3, 4])], [1, 2, 3, 4]);
  const counter = {n: 0};
  for (let i = 0; i < 3 && !game.ended; i++) step(game, counter);
  const clone = game.clone();
  const before = JSON.stringify(game.views.p1.teams.p2);
  for (let i = 0; i < 3 && !clone.ended; i++) step(clone, {n: 99});
  assert.equal(JSON.stringify(game.views.p1.teams.p2), before, 'stepping the clone mutated the original view');
});
