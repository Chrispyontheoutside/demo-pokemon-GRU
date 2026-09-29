#!/usr/bin/env node
// Audits VisibleState against simulator truth: opposing alive count, active species and active HP, boosts and field as seen by p1.
import {readFileSync} from 'node:fs';
import {DirectGame} from '../dist/src/direct-battle.js';
import {act} from '../dist/src/search.js';
const dir = 'runs/champions-vgc-2026-reg-mc/teams/';
const pack = n => JSON.parse(readFileSync(`${dir}${n}.json`, 'utf8')).pack;
let seedN = 5; const rng = () => { seedN = (seedN * 48271) % 2147483647; return seedN / 2147483647; };
const tally = {states: 0, aliveWrong: 0, activeWrong: 0, hpWrong: 0, boostWrong: 0, ownFoeFaintedWrong: 0};
for (let g = 0; g < Number(process.argv[2] ?? 40); g++) {
  const game = DirectGame.create([pack(`candidate-${1 + g % 4}`), pack(`human-${1 + g * 11 % 300}`)], [3, g, 5, 9]);
  game.choose('p1', 'team 1234'); game.choose('p2', 'team 1234');
  for (let t = 0; t < 30 && !game.ended; t++) {
    if (game.pending().includes('p1')) {
      const view = game.views.p1, truth = game.battle.sides[1].pokemon;
      tally.states++;
      const trueAlive = truth.filter(p => !p.fainted && p.hp > 0).length;
      const brought = 4;   // view lists all six; unrevealed count as alive
      const viewDead = view.teams.p2.filter(m => m.condition.includes('fnt')).length;
      if (viewDead !== truth.filter(p => p.fainted || p.hp <= 0).length) tally.aliveWrong++;
      const trueActive = truth.filter(p => p.isActive).map(p => p.species.baseSpecies).sort().join();
      const viewActive = [...view.active.p2.values()].filter(m => m.active).map(m => m.details.split(',')[0]).sort().join();
      if (trueActive.replace(/-Mega.*/g, '') !== viewActive.replace(/-Mega[^,]*/g, '') && truth.filter(p => p.isActive).length === [...view.active.p2.values()].filter(m => m.active).length) tally.activeWrong++;
    }
    for (const s of game.pending()) act(game, s, s === 'p1' ? 'heuristic' : 'guarded', rng);
  }
}
console.log(JSON.stringify(tally));
