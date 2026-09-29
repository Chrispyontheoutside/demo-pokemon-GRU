// Rebuilds a searchable simulator battle from what one side knows mid-battle (its own request + its VisibleState), for ladder-side
// rollout search. Our team is exact; the opposing team is a determinization: observed species/HP/status/boosts/field are copied,
// unrevealed moves/items/abilities are sampled from per-species frequencies over our own ladder observations. Nothing is read from the
// opposing request. Durations (tailwind turns, trick room turns, protect streaks) are not observable and take simulator defaults.
import {readFileSync} from 'node:fs';
import showdown from 'pokemon-showdown';
import {packValidatedTeam} from './champions-worker.js';
import {VisibleState, type SideId} from './champions.js';
import {DirectGame} from './direct-battle.js';

const {Dex, Teams} = showdown as any;
const dex = Dex.forFormat('gen9championsvgc2026regmc');
const toId = (text: string) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const speciesOf = (details: string) => String(details).split(',')[0].trim();
const baseOf = (details: string) => dex.species.get(speciesOf(details)).baseSpecies;

type Stats = Record<string, {moves: Record<string, number>; items: Record<string, number>; abilities: Record<string, number>}>;
let pooled: Stats | undefined;
function speciesStats(): Stats {
  if (pooled) return pooled;
  pooled = {};
  try {
    const raw = JSON.parse(readFileSync(new URL('../../runs/champions-vgc-2026-reg-mc/human-teams/raw.json', import.meta.url), 'utf8'));
    for (const team of raw) for (const [species, info] of Object.entries<any>(team.revealed)) {
      const s = (pooled[species] ??= {moves: {}, items: {}, abilities: {}});
      for (const move of info.moves) s.moves[move] = (s.moves[move] ?? 0) + 1;
      if (info.item) s.items[info.item] = (s.items[info.item] ?? 0) + 1;
      if (info.ability) s.abilities[info.ability] = (s.abilities[info.ability] ?? 0) + 1;
    }
  } catch { /* fall back to uniform choices */ }
  return pooled;
}

const weighted = (entries: [string, number][], exclude: Set<string>, random: () => number) => {
  const pool = entries.filter(([key]) => !exclude.has(key));
  const total = pool.reduce((n, [, w]) => n + w, 0);
  if (!pool.length || total <= 0) return undefined;
  let draw = random() * total;
  for (const [key, w] of pool) { draw -= w; if (draw <= 0) return key; }
  return pool[pool.length - 1][0];
};
const legalMovesCache = new Map<string, string[]>();
function legalMoves(species: string) {
  let out = legalMovesCache.get(species);
  if (!out) {
    out = [...new Set<string>(dex.species.getFullLearnset(dex.species.get(species).id).flatMap((entry: any) => Object.keys(entry.learnset)))]
      .map(id => dex.moves.get(id)).filter((m: any) => m.exists && !m.isNonstandard && !m.isZ && !m.isMax).map((m: any) => m.name);
    legalMovesCache.set(species, out);
  }
  return out;
}
const megaStoneFor = (megaForme: string) => dex.items.all().find((item: any) => item.exists && item.megaStone && Object.values(item.megaStone).includes(megaForme))?.name;
const allItems = () => dex.items.all().filter((i: any) => i.exists && !i.isNonstandard && !i.megaStone && !i.zMove).map((i: any) => i.name);

interface Seen {species: string; moves: string[]; item: string; ability: string; mega?: string}

/** One plausible full set for an opposing species, consistent with everything revealed. */
function guessSet(seen: Seen, used: Set<string>, random: () => number) {
  const stats = speciesStats()[seen.species] ?? {moves: {}, items: {}, abilities: {}};
  const specie = dex.species.get(seen.species);
  const all = legalMoves(seen.species);
  const known = (seen.moves ?? []).map(name => dex.moves.get(name)).filter((m: any) => m.exists && all.includes(m.name)).map((m: any) => m.name);
  const moves = new Set<string>(known);
  while (moves.size < 4) {
    const fromStats = weighted(Object.entries(stats.moves), moves, random);
    const move = fromStats && all.includes(fromStats) ? fromStats : all.filter(m => !moves.has(m))[Math.floor(random() * all.length)];
    if (!move) break;
    moves.add(move);
  }
  let item = seen.mega ? megaStoneFor(seen.mega) : seen.item && dex.items.get(seen.item).exists && !used.has(seen.item) ? dex.items.get(seen.item).name : undefined;
  if (!item) item = weighted(Object.entries(stats.items), used, random);
  const items = allItems();
  while (!item || used.has(item)) item = items[Math.floor(random() * items.length)];
  used.add(item);
  const abilities = Object.values<string>(specie.abilities);
  let ability = seen.ability && abilities.includes(seen.ability) ? seen.ability : undefined;
  if (!ability) { const c = weighted(Object.entries(stats.abilities), new Set(), random); ability = c && abilities.includes(c) ? c : abilities[Math.floor(random() * abilities.length)]; }
  return {name: specie.name, species: specie.name, item, ability, moves: [...moves].slice(0, 4), nature: 'Serious', gender: specie.gender ?? '', level: 50,
    evs: {hp: 11, atk: 11, def: 11, spa: 11, spd: 11, spe: 11}, ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31}};
}

export interface ReconstructInput {
  side: SideId;
  request: any;                  // our current move request: exact team, HP, moves
  view: VisibleState;            // what we have observed
  ownPack: string;               // packed six-Pokemon team file we registered with
  random: () => number;
  seed?: number[];
}

const hpFraction = (condition: string) => { const m = /^(\d+)\/(\d+)/.exec(String(condition)); return m ? Number(m[1]) / Number(m[2]) : String(condition).includes('fnt') ? 0 : 1; };
const statusOf = (condition: string) => String(condition).split(' ')[1] ?? '';

/** Returns a DirectGame positioned at our current decision, or undefined when the situation is outside what we reconstruct. */
export const failures: Record<string, number> = {};
const fail = (reason: string) => { failures[reason] = (failures[reason] ?? 0) + 1; return undefined; };
export function reconstruct(input: ReconstructInput): DirectGame | undefined {
  const {side, request, view, ownPack, random} = input;
  const foe: SideId = side === 'p1' ? 'p2' : 'p1';
  if (!request?.side?.pokemon || request.forceSwitch || request.wait || request.teamPreview) return fail('r2');
  const mine: any[] = request.side.pokemon;
  if (mine.length < 2 || !mine.slice(0, 2).every(p => !String(p.condition).includes('fnt'))) return fail('r3');
  const foeActive = ['a', 'b'].map(letter => view.active[foe].get(`${foe}${letter}`)).filter(m => m && m.active && !m.condition.includes('fnt'));
  if (foeActive.length < 2) return fail('r4');

  // Our full six-set team, addressed by species so the request's current order can be reproduced.
  const ownSets: any[] = Teams.unpack(ownPack);
  const ownIndex = (details: string) => ownSets.findIndex(set => baseOf(set.species || set.name) === baseOf(details));
  const ownOrder = mine.map(p => ownIndex(p.details));
  if (ownOrder.some(i => i < 0)) return fail('r5');

  // Opposing six: every species from the preview, revealed information from the view.
  // A Pokemon that mega-evolved can appear twice in the view (details changed after the preview entry): keep the informative entry.
  const byBase = new Map<string, (typeof view.teams)[SideId][number]>();
  for (const mon of view.teams[foe]) {
    const key = baseOf(mon.details), held = byBase.get(key);
    if (!held || (mon.active && !held.active) || (!held.active && held.condition === '' && mon.condition !== '')) byBase.set(key, mon);
  }
  const foeTeam = [...byBase.values()];
  if (foeTeam.length < 6) { if (process.env.RECON_DEBUG) console.error('r6', view.teams[foe].map(m => `${m.details}|${m.condition}`).join(' ; ')); return fail('r6'); }
  const seenOf = (mon: (typeof foeTeam)[number]): Seen => {
    const mega = speciesOf(mon.details).includes('-Mega') ? speciesOf(mon.details) : undefined;
    const base = mega ? dex.species.get(mega).baseSpecies : speciesOf(mon.details);
    return {species: dex.species.get(base).name, moves: mon.moves, item: mon.item, ability: mon.ability, mega};
  };
  const foeIndexOf = (mon: (typeof foeTeam)[number] | undefined) => foeTeam.indexOf(mon as any);
  const activeIdx = foeActive.map(m => foeIndexOf(m));
  const revealed = foeTeam.map((m, i) => ({m, i})).filter(({m, i}) => (m.condition !== '' || m.active) && !activeIdx.includes(i)).map(({i}) => i);
  const unrevealed = foeTeam.map((_, i) => i).filter(i => !activeIdx.includes(i) && !revealed.includes(i));
  for (let i = unrevealed.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [unrevealed[i], unrevealed[j]] = [unrevealed[j], unrevealed[i]]; }
  const foeOrder = [...activeIdx, ...revealed, ...unrevealed].slice(0, 4);
  if (foeOrder.length < 4) return fail('r7');

  let foePack: string | undefined;
  for (let attempt = 0; attempt < 12 && !foePack; attempt++) {
    const used = new Set<string>();
    try { foePack = packValidatedTeam(foeTeam.map(mon => guessSet(seenOf(mon), used, random))); } catch (error) { if (process.env.RECON_DEBUG) console.error(String((error as Error).message).slice(0, 300)); }
  }
  if (!foePack) return fail('r8');
  const packs: Record<SideId, string> = side === 'p1' ? {p1: ownPack, p2: foePack} : {p1: foePack, p2: ownPack};
  const seed = input.seed ?? [Math.floor(random() * 65536), Math.floor(random() * 65536), Math.floor(random() * 65536), Math.floor(random() * 65536)];
  const game = DirectGame.create([packs.p1, packs.p2], seed);
  const previewChoice = (order: number[]) => `team ${order.map(i => i + 1).join('')}`;
  const choices: Record<SideId, string> = {p1: '', p2: ''};
  choices[side] = previewChoice(ownOrder);
  choices[foe] = previewChoice(foeOrder);
  if (!game.choose(side, choices[side]) || !game.choose(foe, choices[foe])) return fail('r9');

  const battle = game.battle;
  const patch = (sideId: SideId, mons: {frac: number; status: string; boosts: Record<string, number>; details: string}[]) => {
    const sim = battle.sides[sideId === 'p1' ? 0 : 1];
    mons.forEach((info, i) => {
      const pokemon = sim.pokemon[i];
      if (!pokemon) return;
      if (info.details.includes('-Mega') && !pokemon.species.isMega) { pokemon.canMegaEvo = pokemon.baseSpecies && battle.actions.canMegaEvo(pokemon); if (pokemon.canMegaEvo) battle.actions.runMegaEvo(pokemon); }
      pokemon.hp = info.frac <= 0 ? 0 : Math.max(1, Math.round(info.frac * pokemon.maxhp));
      if (pokemon.hp === 0) { pokemon.fainted = true; pokemon.isActive = false; sim.pokemonLeft = Math.max(0, sim.pokemonLeft - 1); }
      if (info.status) { pokemon.status = toId(info.status); pokemon.statusState = {id: toId(info.status), target: pokemon, time: 0, stage: 1}; }
      for (const [stat, value] of Object.entries(info.boosts)) if (stat in pokemon.boosts) pokemon.boosts[stat] = value;
    });
  };
  patch(side, mine.map((p, i) => ({frac: hpFraction(p.condition), status: statusOf(p.condition), details: p.details,
    boosts: i < 2 ? (view.active[side].get(`${side}${i ? 'b' : 'a'}`)?.boosts ?? {}) : {}})));
  patch(foe, foeOrder.map((idx, i) => {
    const m = foeTeam[idx];
    return {frac: m.condition === '' ? 1 : hpFraction(m.condition), status: statusOf(m.condition), details: m.details, boosts: i < 2 ? m.boosts : {}};
  }));

  battle.turn = view.turn;
  const field = battle.field;
  if (view.weather) field.setWeather(view.weather);
  if (view.terrain) field.setTerrain(view.terrain);
  if (view.trickRoom) field.addPseudoWeather('trickroom');
  if (view.gravity) field.addPseudoWeather('gravity');
  for (const sideId of ['p1', 'p2'] as SideId[]) {
    const sim = battle.sides[sideId === 'p1' ? 0 : 1];
    for (const condition of view.fields[sideId]) if (['tailwind', 'reflect', 'lightscreen', 'auroraveil', 'safeguard'].includes(condition)) sim.addSideCondition(condition);
  }
  battle.makeRequest('move');
  battle.sendUpdates();
  if (!game.pending().includes(side)) return fail('r10');

  game.views[side] = view.clone();
  game.views[foe] = viewFromBattle(battle, foe, view.turn);
  return game;
}

/** A fully revealed VisibleState of `battle` from `side`'s seat, built through the same protocol lines the real view consumes. */
export function viewFromBattle(battle: any, side: SideId, turn: number): VisibleState {
  const view = new VisibleState();
  const foe: SideId = side === 'p1' ? 'p2' : 'p1';
  for (const sideId of [side, foe]) {
    const sim = battle.sides[sideId === 'p1' ? 0 : 1];
    for (const pokemon of sim.pokemon) view.receive(`|poke|${sideId}|${pokemon.details}|`);
  }
  for (const sideId of [side, foe]) {
    const sim = battle.sides[sideId === 'p1' ? 0 : 1];
    sim.pokemon.forEach((pokemon: any, i: number) => {
      const slot = `${sideId}${i === 0 ? 'a' : 'b'}`;
      if (i < 2) view.receive(`|switch|${slot}: ${pokemon.name}|${pokemon.details}|${pokemon.hp}/${pokemon.maxhp}${pokemon.status ? ' ' + pokemon.status : ''}`);
      for (const [stat, value] of Object.entries<number>(pokemon.boosts ?? {})) if (i < 2 && value) view.receive(`|-setboost|${slot}: ${pokemon.name}|${stat}|${value}`);
      if (i < 2) for (const move of pokemon.baseMoves ?? []) view.receive(`|move|${slot}: ${pokemon.name}|${dex.moves.get(move).name}|`);
    });
  }
  view.turn = turn;
  return view;
}

/** A determinized packed opposing team (all six species, revealed information copied, gaps sampled) from what `view` knows. */
export function guessFoePack(view: VisibleState, foe: SideId, random: () => number): string | undefined {
  const byBase = new Map<string, (typeof view.teams)[SideId][number]>();
  for (const mon of view.teams[foe]) {
    const key = baseOf(mon.details), held = byBase.get(key);
    if (!held || (mon.active && !held.active) || (!held.active && held.condition === '' && mon.condition !== '')) byBase.set(key, mon);
  }
  const team = [...byBase.values()];
  if (team.length < 6) return undefined;
  for (let attempt = 0; attempt < 12; attempt++) {
    const used = new Set<string>();
    try {
      return packValidatedTeam(team.map(mon => {
        const mega = speciesOf(mon.details).includes('-Mega') ? speciesOf(mon.details) : undefined;
        const base = mega ? dex.species.get(mega).baseSpecies : speciesOf(mon.details);
        return guessSet({species: dex.species.get(base).name, moves: mon.moves, item: mon.item, ability: mon.ability, mega}, used, random);
      }));
    } catch { /* resample */ }
  }
  return undefined;
}
