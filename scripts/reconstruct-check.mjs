#!/usr/bin/env node
// Round-trip check for ladder-side reconstruction: play a real simulated game, rebuild it from p1's information only at several turns,
// and compare HP/status/boosts/field/candidate sets against the truth.
import {readFileSync} from 'node:fs';
import {DirectGame} from '../dist/src/direct-battle.js';
import {act} from '../dist/src/search.js';
import {reconstruct, failures} from '../dist/src/reconstruct.js';
const dir = 'runs/champions-vgc-2026-reg-mc/teams/';
const pack = n => JSON.parse(readFileSync(`${dir}${n}.json`, 'utf8')).pack;
let seedN = 1; const rng = () => { seedN = (seedN * 48271) % 2147483647; return seedN / 2147483647; };
const games = Number(process.argv[2] ?? 20);
const tally = {tried: 0, built: 0, candSame: 0, hpSame: 0, mismatchNotes: {}};
for (let g = 0; g < games; g++) {
  const own = pack(`candidate-${1 + g % 4}`), foe = pack(`human-${1 + g * 7 % 300}`);
  const game = DirectGame.create([own, foe], [11, g, 3, 7]);
  game.choose('p1', 'team 1234'); game.choose('p2', 'team 1234');
  for (let turn = 1; turn <= 12 && !game.ended; turn++) {
    if (game.pending().length === 2 && !game.requests.p1.forceSwitch && !game.requests.p2.forceSwitch && [4, 6, 9].includes(turn)) {
      tally.tried++;
      const rebuilt = reconstruct({side: 'p1', request: game.requests.p1, view: game.views.p1, ownPack: own, random: rng});
      if (rebuilt) {
        tally.built++;
        const a = game.battle.sides[0].pokemon, b = rebuilt.battle.sides[0].pokemon;
        const sameOwn = a.every((p, i) => p.hp === b[i].hp && p.status === b[i].status && p.name === b[i].name);
        const fa = game.battle.sides[1].pokemon, fb = rebuilt.battle.sides[1].pokemon;
        const fracs = x => x.map(p => Math.round(100 * p.hp / p.maxhp));
        const foeSeen = game.views.p1.teams.p2.map(m => m.condition);
        const trueFoe = Object.fromEntries(fa.map(p => [p.species.baseSpecies, Math.round(100 * p.hp / p.maxhp)]));
        const rebFoe = Object.fromEntries(fb.map(p => [p.species.baseSpecies, Math.round(100 * p.hp / p.maxhp)]));
        const foeSame = Object.keys(trueFoe).filter(s => rebFoe[s] !== undefined).every(s => Math.abs(trueFoe[s] - rebFoe[s]) <= 1 || rebFoe[s] === 100 && !foeSeen.some(c => c));
        tally.hpSame += sameOwn && foeSame;
        const ca = game.encodeFor('p1').candidates.map(c => c.choice).sort().join('|'), cb = rebuilt.encodeFor('p1').candidates.map(c => c.choice).sort().join('|');
        tally.candSame += ca === cb;
        if (ca !== cb) tally.mismatchNotes[`g${g}t${turn}`] = {true: game.encodeFor('p1').candidates.length, rebuilt: rebuilt.encodeFor('p1').candidates.length};
        if (!(sameOwn && foeSame)) tally.mismatchNotes[`hp-g${g}t${turn}`] = {own: a.map(p => `${p.name}:${p.hp}`).join(','), ownRebuilt: b.map(p => `${p.name}:${p.hp}`).join(','), trueFoe, rebFoe};
      }
    }
    for (const s of game.pending()) act(game, s, s === 'p1' ? 'heuristic' : 'guarded', rng);
  }
}
tally.failures = failures; console.log(JSON.stringify(tally, null, 1).slice(0, 3000));
