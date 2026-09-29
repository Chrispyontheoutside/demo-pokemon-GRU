#!/usr/bin/env node
// Builds legal, validated Reg M-C teams that mirror the opposing teams seen in OUR OWN ladder games. Each team keeps its observed six
// species and every move/item/ability actually revealed; the gaps are filled from per-species frequencies pooled over all our games
// (falling back to random legal choices). Stat points come from the project's role-based optimiser. Output: teams/human-*.json.
//   node scripts/build-human-teams.mjs [--heldout 60] [--out runs/champions-vgc-2026-reg-mc/teams]
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import showdown from 'pokemon-showdown';
import {packValidatedTeam} from '../dist/src/champions-worker.js';

const {Dex, TeamValidator, PRNG} = showdown;
const FORMAT = 'gen9championsvgc2026regmc';
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const heldout = Number(opt('--heldout', 60)), outDir = opt('--out', 'runs/champions-vgc-2026-reg-mc/teams');
const raw = JSON.parse(readFileSync('runs/champions-vgc-2026-reg-mc/human-teams/raw.json', 'utf8'));
const dex = Dex.forFormat(FORMAT), validator = new TeamValidator(FORMAT);
const rng = new PRNG('7,11,13,17');
const pick = list => list[Math.floor(rng.random() * list.length)];
const weighted = (entries, exclude = new Set()) => {
  const pool = entries.filter(([key]) => !exclude.has(key));
  const total = pool.reduce((n, [, w]) => n + w, 0);
  if (!pool.length || total <= 0) return undefined;
  let draw = rng.random() * total;
  for (const [key, w] of pool) { draw -= w; if (draw <= 0) return key; }
  return pool.at(-1)[0];
};

// Pooled per-species statistics from every observed game.
const stats = {};
for (const team of raw) for (const [species, info] of Object.entries(team.revealed)) {
  const s = (stats[species] ??= {moves: {}, items: {}, abilities: {}});
  for (const move of info.moves) s.moves[move] = (s.moves[move] ?? 0) + 1;
  if (info.item) s.items[info.item] = (s.items[info.item] ?? 0) + 1;
  if (info.ability) s.abilities[info.ability] = (s.abilities[info.ability] ?? 0) + 1;
}
const allItems = dex.items.all().filter(i => i.exists && !i.isNonstandard && !i.megaStone && !i.zMove).map(i => i.name);
const legalMoves = species => [...new Set(dex.species.getFullLearnset(dex.species.get(species).id).flatMap(entry => Object.keys(entry.learnset)))]
  .map(id => dex.moves.get(id)).filter(m => m.exists && !m.isNonstandard && !m.isZ && !m.isMax).map(m => m.name);

function makeSet(species, info, usedItems, attempt) {
  const s = stats[species] ?? {moves: {}, items: {}, abilities: {}};
  const specie = dex.species.get(species);
  const moves = new Set((info?.moves ?? []).filter(name => dex.moves.get(name).exists));
  const all = legalMoves(species);
  while (moves.size < 4) {
    const fromStats = attempt < 4 ? weighted(Object.entries(s.moves), moves) : undefined;
    const move = fromStats && all.includes(fromStats) ? fromStats : pick(all.filter(m => !moves.has(m)));
    if (!move) break;
    moves.add(move);
  }
  let item = info?.item && !usedItems.has(info.item) ? info.item : undefined;
  if (!item && attempt < 4) item = weighted(Object.entries(s.items), usedItems);
  while (!item || usedItems.has(item)) item = pick(allItems);
  usedItems.add(item);
  const abilities = Object.values(specie.abilities);
  let ability = info?.ability && abilities.includes(info.ability) ? info.ability : undefined;
  if (!ability) { const candidate = weighted(Object.entries(s.abilities)); ability = candidate && abilities.includes(candidate) ? candidate : pick(abilities); }
  return {name: specie.name, species: specie.name, item, ability, moves: [...moves].slice(0, 4), nature: 'Serious',
    gender: specie.gender ?? '', level: 50, evs: {hp: 11, atk: 11, def: 11, spa: 11, spd: 11, spe: 11}, ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31}};
}

const built = [];
const failures = {};
for (const team of raw) {
  let pack;
  for (let attempt = 0; attempt < 12 && !pack; attempt++) {
    const used = new Set();
    const sets = team.species.map(species => makeSet(species, team.revealed[species], used, attempt));
    try { pack = packValidatedTeam(sets); } catch (error) { failures[String(error.message).slice(0, 60)] = (failures[String(error.message).slice(0, 60)] ?? 0) + 1; }
  }
  if (pack) built.push({species: team.species, pack, room: team.room});
}
// Unique by pack; hold out the last `heldout` for evaluation only.
const unique = [...new Map(built.map(t => [t.pack, t])).values()];
const train = unique.slice(0, Math.max(0, unique.length - heldout)), held = unique.slice(-heldout);
const write = (team, name, split) => writeFileSync(`${outDir}/${name}.json`, JSON.stringify({split, species: team.species, pack: team.pack, source: 'built from own ladder observations',
  teamSHA256: createHash('sha256').update(team.pack).digest('hex')}, null, 1));
train.forEach((t, i) => write(t, `human-${i + 1}`, 'train'));
held.forEach((t, i) => write(t, `human-heldout-${i + 1}`, 'heldout'));
console.log(JSON.stringify({observedTeams: raw.length, validTeams: built.length, unique: unique.length, train: train.length, heldout: held.length, failures}));
