#!/usr/bin/env node
// Field-level audit of VisibleState (p1's view) against simulator truth, per turn: active identity, HP, status, boosts, field/weather/terrain, side conditions.
import {readFileSync} from 'node:fs';
import {DirectGame} from '../dist/src/direct-battle.js';
import {act} from '../dist/src/search.js';
const dir = 'runs/champions-vgc-2026-reg-mc/teams/';
const pack = n => JSON.parse(readFileSync(`${dir}${n}.json`, 'utf8')).pack;
let seedN = 9; const rng = () => { seedN = (seedN * 48271) % 2147483647; return seedN / 2147483647; };
const id = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const bad = {}, total = {}; const note = (k, ok, detail) => { total[k] = (total[k] ?? 0) + 1; if (!ok) { bad[k] = (bad[k] ?? 0) + 1; (bad[k + '_ex'] ??= []).length < 3 && bad[k + '_ex'].push(detail); } };
for (let g = 0; g < Number(process.argv[2] ?? 60); g++) {
  const game = DirectGame.create([pack(`candidate-${1 + g % 4}`), pack(`human-${1 + g * 11 % 300}`)], [3, g, 5, 9]);
  game.choose('p1', 'team 1234'); game.choose('p2', 'team 1234');
  for (let t = 0; t < 30 && !game.ended; t++) {
    if (game.pending().includes('p1')) {
      const view = game.views.p1, b = game.battle;
      for (const side of ['p1', 'p2']) {
        const truth = b.sides[side === 'p1' ? 0 : 1];
        for (const [slot, mon] of view.active[side]) {
          if (!mon.active) continue;
          const pos = 'ab'.indexOf(slot[2]); const p = truth.active[pos]; if (!p) continue;
          const who = side === 'p1' ? 'own' : 'foe';
          const frac = Math.round(100 * p.hp / p.maxhp), seen = /^(\d+)\/(\d+)/.exec(mon.condition);
          const seenFrac = seen ? (side === 'p1' ? Math.round(100 * Number(seen[1]) / Number(seen[2])) : Number(seen[1])) : null;
          note(`${who}.hp`, seenFrac === null || Math.abs(seenFrac - frac) <= 1, {turn: t, seen: mon.condition, frac});
          note(`${who}.status`, (mon.condition.split(' ')[1] ?? '') === (p.status ?? ''), {seen: mon.condition, truth: p.status});
          const boosts = Object.entries(p.boosts).filter(([, v]) => v);
          const seenBoosts = Object.entries(mon.boosts).filter(([, v]) => v);
          note(`${who}.boosts`, boosts.length === seenBoosts.length && boosts.every(([k, v]) => mon.boosts[k] === v), {truth: p.boosts, seen: mon.boosts, turn: t});
          note(`${who}.species`, id(mon.details.split(',')[0]).startsWith(id(p.species.baseSpecies)), {seen: mon.details, truth: p.species.name});
          note(`${who}.item`, side === 'p1' ? (id(mon.item) === id(p.item) || !mon.item) : (!mon.item || id(mon.item) === id(p.item)), {seen: mon.item, truth: p.item});
        }
      }
      note('weather', id(view.weather) === id(b.field.weather), {seen: view.weather, truth: b.field.weather});
      note('terrain', id(view.terrain) === id(b.field.terrain), {seen: view.terrain, truth: b.field.terrain});
      note('trickroom', view.trickRoom === Boolean(b.field.pseudoWeather.trickroom), {t});
      for (const side of ['p1', 'p2']) {
        const truth = Object.keys(b.sides[side === 'p1' ? 0 : 1].sideConditions).map(id).sort().join();
        note('sideconds', [...view.fields[side]].map(id).sort().join() === truth, {side, seen: [...view.fields[side]], truth});
      }
    }
    for (const s of game.pending()) act(game, s, s === 'p1' ? 'heuristic' : 'guarded', rng);
  }
}
for (const k of Object.keys(total)) console.log(k.padEnd(14), `${bad[k] ?? 0}/${total[k]}`, bad[k + '_ex'] ? JSON.stringify(bad[k + '_ex']).slice(0, 260) : '');
