import showdown from 'pokemon-showdown';

export const CHAMPIONS_FORMAT = 'gen9championsvgc2026regmb';
export const CHAMPIONS_ENGINE_VERSION = '0.11.11';
export const STATE_DIM = 800;
export const ACTION_DIM = 56;
export type SideId = 'p1' | 'p2';
export interface Candidate { choice: string; features: number[]; simpleScore: number }
export interface Encoded { state: number[]; candidates: Candidate[] }

const dex = showdown.Dex.forFormat(CHAMPIONS_FORMAT);
const types = ['Normal','Fire','Water','Electric','Grass','Ice','Fighting','Poison','Ground','Flying','Psychic','Bug','Rock','Ghost','Dragon','Dark','Steel','Fairy'];
const statuses = ['brn','par','slp','frz','psn','tox'];
const stats = ['hp','atk','def','spa','spd','spe'];
const statIndex: Record<string, number> = {hp: 0, atk: 1, def: 2, spa: 3, spd: 4, spe: 5, accuracy: 6, evasion: 7};
const statusId = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

function hashed(value: string, size: number) {
  const id = statusId(value);
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619) >>> 0;
  return id ? hash % size : -1;
}

function fillHash(out: number[], offset: number, size: number, value: string) {
  const index = hashed(value, size);
  if (index >= 0) out[offset + index] = 1;
}

function speciesName(details: string) { return (details.split(',')[0] ?? '').trim(); }

function hp(condition: string | undefined) {
  if (!condition || condition.includes('fnt')) return 0;
  const fraction = /^(\d+)\/(\d+)/.exec(condition);
  if (fraction) return Math.max(0, Math.min(1, Number(fraction[1]) / Number(fraction[2])));
  const percent = /^(\d+(?:\.\d+)?)%/.exec(condition);
  return percent ? Math.max(0, Math.min(1, Number(percent[1]) / 100)) : 1;
}

function statValues(pokemon: any) {
  if (pokemon.stats) return stats.map((name: string) => Number(pokemon.stats[name] ?? 0) / 400);
  const species = dex.species.get(pokemon.species ?? speciesName(pokemon.details ?? ''));
  return stats.map((name: string) => Number(species.baseStats[name] ?? 0) / 200);
}

function monFeatures(pokemon: any, visible?: VisibleMon) {
  const out = new Array<number>(64).fill(0);
  const details = pokemon.details ?? pokemon.species ?? visible?.details ?? '';
  const name = pokemon.species ?? speciesName(details);
  const species = dex.species.get(name);
  const condition = pokemon.condition ?? visible?.condition ?? '';
  out[0] = hp(condition);
  out[1] = Number(pokemon.active === true || visible?.active === true);
  out[2] = Number(condition.includes('fnt'));
  const status = condition.split(' ')[1] ?? '';
  const statusSlot = statuses.indexOf(status);
  if (statusSlot >= 0) out[3 + statusSlot] = 1;
  statValues({...pokemon, species: name, details}).forEach((value: number, i: number) => out[9 + i] = Math.min(1, value));
  const pokemonTypes: string[] = visible?.types ?? species.types ?? [];
  types.forEach((type, i) => out[15 + i] = Number(pokemonTypes.includes(type)));
  const boosts = visible?.boosts ?? {};
  stats.concat(['accuracy','evasion']).forEach((name: string, i: number) => out[33 + i] = (Number(boosts[name] ?? 0) / 6));
  fillHash(out, 40, 8, name);
  fillHash(out, 48, 4, pokemon.item ?? visible?.item ?? '');
  fillHash(out, 52, 4, pokemon.baseAbility ?? pokemon.ability ?? visible?.ability ?? '');
  const moves: string[] = pokemon.moves ?? visible?.moves ?? [];
  for (const move of moves) fillHash(out, 56, 8, move);
  return out;
}

interface VisibleMon {
  details: string; condition: string; types: string[]; active: boolean;
  boosts: Record<string, number>; ability: string; item: string; moves: string[];
}

export class VisibleState {
  turn = 0;
  weather = '';
  terrain = '';
  trickRoom = false;
  gravity = false;
  readonly teams: Record<SideId, VisibleMon[]> = {p1: [], p2: []};
  readonly active: Record<SideId, Map<string, VisibleMon>> = {p1: new Map(), p2: new Map()};
  readonly fields: Record<SideId, Set<string>> = {p1: new Set(), p2: new Set()};

  receive(line: string) {
    if (!line.startsWith('|')) return;
    const parts = line.split('|');
    const command = parts[1] ?? '';
    const who = parts[2] ?? '';
    const arg = parts[3] ?? '';
    const value = parts[4] ?? '';
    const side = who.slice(0, 2) as SideId;
    if (command === 'turn') this.turn = Number(who) || this.turn;
    if ((command === 'poke' || command === 'showteam') && (side === 'p1' || side === 'p2')) {
      if (command === 'showteam') {
        const packed = parts.slice(3).join('|');
        const team = showdown.Teams.unpack(packed) ?? [];
        this.teams[side] = team.map(set => this.makeMon({species: set.species || set.name, item: set.item, ability: set.ability, moves: set.moves}));
      } else if (arg) {
        const name = speciesName(arg);
        if (!this.teams[side].some(mon => statusId(speciesName(mon.details)) === statusId(name))) this.teams[side].push(this.makeMon({species: name}));
      }
    }
    if (['switch','drag','replace'].includes(command) && (side === 'p1' || side === 'p2')) {
      const slot = who.split(':')[0];
      const previous = this.active[side].get(slot);
      if (previous) previous.active = false;
      const mon = this.findMon(side, who, arg);
      if (mon) {
        mon.details = arg;
        mon.types = dex.species.get(speciesName(arg)).types;
        mon.condition = value;
        mon.active = true;
        this.active[side].set(who.split(':')[0], mon);
      }
    }
    const current = this.active[side]?.get(who.split(':')[0]);
    if (current) {
      if (['-damage','-heal','-sethp'].includes(command)) current.condition = arg;
      if (command === 'faint') { current.condition = '0 fnt'; current.active = false; }
      if (command === '-status') current.condition = `${current.condition.split(' ')[0]} ${arg}`;
      if (command === '-curestatus') current.condition = current.condition.split(' ')[0];
      if (command === 'move' && arg && !current.moves.includes(arg)) current.moves.push(arg);
      if (command === '-ability') current.ability = arg;
      if (command === '-item') current.item = arg;
      if (command === '-enditem') current.item = '';
      if (command === '-boost' || command === '-unboost') {
        const key = statusId(arg);
        const delta = (Number(value) || 0) * (command === '-boost' ? 1 : -1);
        current.boosts[key] = Math.max(-6, Math.min(6, (current.boosts[key] ?? 0) + delta));
      }
      if (command === '-setboost') current.boosts[statusId(arg)] = Number(value) || 0;
      if (command === '-clearboost') current.boosts = {};
      if (command === 'detailschange' || command === '-formechange') {
        current.details = arg;
        current.types = dex.species.get(speciesName(arg)).types;
      }
    }
    if (command === '-weather') this.weather = arg.toLowerCase() === 'none' ? '' : statusId(arg);
    if (command === '-fieldstart') {
      if (arg.toLowerCase().includes('trick room')) this.trickRoom = true;
      if (arg.toLowerCase().includes('gravity')) this.gravity = true;
      if (arg.toLowerCase().includes('terrain')) this.terrain = statusId(arg);
    }
    if (command === '-fieldend') {
      if (arg.toLowerCase().includes('trick room')) this.trickRoom = false;
      if (arg.toLowerCase().includes('gravity')) this.gravity = false;
      if (arg.toLowerCase().includes('terrain')) this.terrain = '';
    }
    if (command === '-sidestart' && (side === 'p1' || side === 'p2')) this.fields[side].add(statusId(arg));
    if (command === '-sideend' && (side === 'p1' || side === 'p2')) this.fields[side].delete(statusId(arg));
  }

  private makeMon(set: any): VisibleMon {
    const details = set.details ?? set.species ?? '';
    return {details, condition: '', types: dex.species.get(speciesName(details)).types, active: false,
      boosts: {}, ability: set.ability ?? '', item: set.item ?? '', moves: [...(set.moves ?? [])]};
  }

  private findMon(side: SideId, ident: string, details: string) {
    const key = ident.split(':')[0];
    const active = this.active[side].get(key);
    if (active) return active;
    const species = statusId(speciesName(details));
    let mon = this.teams[side].find(entry => statusId(speciesName(entry.details)) === species);
    if (!mon) { mon = this.makeMon({species: speciesName(details)}); this.teams[side].push(mon); }
    return mon;
  }
}

function packState(request: any, view: VisibleState, side: SideId, preview: boolean) {
  const foe: SideId = side === 'p1' ? 'p2' : 'p1';
  const ownTeam = Array.isArray(request.side?.pokemon) ? request.side.pokemon : [];
  const foeTeam = view.teams[foe];
  const state = new Array<number>(STATE_DIM).fill(0);
  state[0] = Math.min(4, view.turn / 100);
  state[1] = Number(preview);
  state[2] = Number(Array.isArray(request.forceSwitch) && request.forceSwitch.some(Boolean));
  state[3] = ownTeam.filter((p: any) => !String(p.condition).includes('fnt')).length / 6;
  state[4] = foeTeam.filter(p => !p.condition.includes('fnt')).length / 6;
  state[5] = Number(!!request.active?.some((a: any) => a.canMegaEvo));
  state[6] = Number(view.trickRoom);
  state[7] = Number(view.gravity);
  const weather = ['sunnyday','raindance','sandstorm','hail','snow','desolateland','primordialsea','deltastream'];
  weather.forEach((value, i) => state[8 + i] = Number(view.weather === value));
  const terrain = ['electricterrain','grassyterrain','mistyterrain','psychicterrain'];
  terrain.forEach((value, i) => state[16 + i] = Number(view.terrain.includes(value)));
  ['stealthrock','spikes','toxicspikes','stickyweb','reflect','lightscreen','tailwind','safeguard'].forEach((value, i) => {
    state[20 + i] = Number(view.fields[side].has(value));
    state[28 + i] = Number(view.fields[foe].has(value));
  });
  for (let i = 0; i < 6; i++) {
    const own = ownTeam[i] ?? {};
    const ownVisible = view.teams[side].find(mon => statusId(speciesName(mon.details)) === statusId(speciesName(own.details ?? '')));
    state.splice(32 + i * 64, 64, ...monFeatures(own, ownVisible));
    state.splice(32 + (6 + i) * 64, 64, ...monFeatures(foeTeam[i] ?? {}));
  }
  return state;
}

function hpFrom(pokemon: any) { return hp(pokemon?.condition); }
function monTypes(pokemon: any): string[] { return dex.species.get(pokemon?.details ? speciesName(pokemon.details) : pokemon?.species ?? '').types ?? []; }
function effectiveness(moveType: string, target: any) {
  const targetTypes = target?.types?.length ? target.types : monTypes(target);
  if (!targetTypes.length || !dex.getImmunity(moveType, targetTypes)) return targetTypes.length ? 0 : 1;
  return 2 ** dex.getEffectiveness(moveType, targetTypes);
}

function emptyComponent(kind: 'move'|'switch'|'pass'|'preview') {
  const out = new Array<number>(24).fill(0);
  out[{move: 0, switch: 1, pass: 2, preview: 3}[kind]] = 1;
  return out;
}

function moveOptions(active: any, activeSlot: number, request: any, view: VisibleState, side: SideId) {
  const options: Array<{choice: string; features: number[]; mega: boolean; switchSlot?: number; target?: number; score: number}> = [];
  const moves = Array.isArray(active?.moves) ? active.moves : [];
  const foes: SideId = side === 'p1' ? 'p2' : 'p1';
  const targets = [`${foes}a`, `${foes}b`].map(ident => view.active[foes].get(ident));
  for (let moveSlot = 0; moveSlot < moves.length; moveSlot++) {
    const requestMove = moves[moveSlot];
    if (requestMove.disabled) continue;
    const move = dex.moves.get(requestMove.id ?? requestMove.move);
    // The request's target field is authoritative. Some format-specific move
    // requests omit it even though the Dex move has a normal target.
    const targetType = requestMove.target;
    let aim: Array<number | null> = [null];
    if (['normal','any','adjacentFoe'].includes(targetType)) aim = request.active?.length > 1 ? [0,1] : [null];
    else if (targetType === 'adjacentAlly') aim = request.active?.length > 1 ? [activeSlot === 0 ? -2 : -1] : [null];
    else if (targetType === 'adjacentAllyOrSelf') aim = request.active?.length > 1 ? [-1,-2] : [null];
    const canMega = active?.canMegaEvo === true;
    for (const target of aim) for (const mega of (canMega ? [false,true] : [false])) {
      const targetArg = target === null ? '' : ` ${target < 0 ? target : target + 1}`;
      const choice = `move ${moveSlot + 1}${targetArg}${mega ? ' mega' : ''}`;
      const features = emptyComponent('move');
      const power = move.basePower || (move.damage || move.damageCallback ? 70 : 0);
      const accuracy = move.accuracy === true ? 1 : Number(move.accuracy) / 100;
      const own = request.side.pokemon.filter((p: any) => p.active)[activeSlot] ?? {};
      const ownTypes = monTypes(own);
      let eff = 1;
      if (target !== null && target >= 0) {
        const knownTarget = targets[target];
        eff = effectiveness(move.type, knownTarget);
      } else if (move.target === 'allAdjacentFoes' || move.target === 'allAdjacent') {
        eff = Math.max(1, ...targets.map(mon => effectiveness(move.type, mon)));
      }
      const stab = ownTypes.includes(move.type) ? 1.5 : 1;
      features[3] = Math.min(2, power / 150);
      features[4] = Math.max(0, Math.min(1, accuracy));
      features[5] = Math.max(-1, Math.min(1, move.priority / 5));
      features[6] = Number(move.category === 'Physical');
      features[7] = Number(move.category === 'Special');
      features[8] = Number(move.category === 'Status');
      features[9] = Math.min(4, eff) / 4;
      features[10] = stab / 1.5;
      features[11] = hpFrom(own);
      features[12] = Number(requestMove.pp ?? 0) / Math.max(1, Number(requestMove.maxpp ?? 1));
      features[13] = Number(mega);
      features[14] = Number(['allAdjacentFoes','allAdjacent'].includes(move.target));
      features[15] = Number(Boolean(move.category === 'Status' && (move.heal || move.boosts || move.status || move.volatileStatus)));
      features[16] = target === null ? 0 : target < 0 ? 0.5 : (target + 1) / 2;
      features[17] = Number(target !== null && target < 0);
      fillHash(features, 18, 4, move.id);
      fillHash(features, 22, 2, move.type);
      const score = power * accuracy * Math.max(0.25, eff) * stab / 100 + move.priority * 0.05 + (features[15] ? 0.2 : 0) + Number(mega) * 0.05;
      options.push({choice, features, mega, target: target ?? undefined, score});
    }
  }
  if (!moves.length) options.push({choice:'move 1',features:emptyComponent('move'),mega:false,score:0.05});
  const forced = request.forceSwitch?.[activeSlot] === true;
  if (forced || !active?.trapped) {
    request.side.pokemon.forEach((pokemon: any, index: number) => {
      if (pokemon.active || hpFrom(pokemon) <= 0) return;
      const features = emptyComponent('switch');
      const incoming = {...pokemon, types: monTypes(pokemon)};
      const maxAttack = Math.max(1, ...targets.flatMap(mon => types.map(type => effectiveness(type ?? '', incoming))));
      features[9] = Math.min(4, maxAttack) / 4;
      features[11] = hpFrom(pokemon);
      features[16] = (index + 1) / 6;
      fillHash(features, 18, 4, speciesName(pokemon.details));
      types.forEach((type,i) => features[22 + (i % 2)] = Number(incoming.types.includes(type)));
      options.push({choice:`switch ${index+1}`,features,mega:false,switchSlot:index,score:0.12 + hpFrom(pokemon) * 0.08 - maxAttack * 0.02});
    });
  }
  return options;
}

function previewCandidates(request: any): Candidate[] {
  const team = request.side.pokemon as any[];
  const candidates: Candidate[] = [];
  for (let leadA = 0; leadA < team.length; leadA++) for (let leadB = 0; leadB < team.length; leadB++) {
    if (leadA === leadB) continue;
    const rest = team.map((_: any,i: number) => i).filter((i: number) => i !== leadA && i !== leadB);
    for (let x = 0; x < rest.length; x++) for (let y = x + 1; y < rest.length; y++) {
      const selected = [leadA, leadB, rest[x], rest[y]];
      const features = new Array<number>(ACTION_DIM).fill(0);
      let simpleScore = 0;
      selected.forEach((slot, position) => {
        const pokemon = team[slot];
        const mon = dex.species.get(speciesName(pokemon.details));
        const offset = position < 2 ? position * 24 : 48 + (position - 2) * 4;
        if (position < 2) {
          features[offset] = 1;
          stats.forEach((name: string,i: number) => features[offset + 3 + i] = Math.min(1, Number(mon.baseStats[name] ?? 0) / 200));
          const typesHash = mon.types.map((type: string) => hashed(type, 2)).filter((i: number) => i >= 0);
          for (const index of typesHash) features[offset + 22 + index] = 1;
        } else {
          features[offset] = Number(hpFrom(pokemon) > 0);
          features[offset + 1] = Math.min(1, Number(mon.baseStats.spe ?? 0) / 200);
          features[offset + 2] = Math.min(1, (Number(mon.baseStats.def ?? 0) + Number(mon.baseStats.spd ?? 0)) / 400);
          features[offset + 3] = Math.min(1, (Number(mon.baseStats.atk ?? 0) + Number(mon.baseStats.spa ?? 0)) / 400);
        }
        simpleScore += Number(mon.baseStats.spe ?? 0) * 0.001 + (Number(mon.baseStats.hp ?? 0) + Number(mon.baseStats.def ?? 0) + Number(mon.baseStats.spd ?? 0)) * 0.0005;
      });
      candidates.push({choice:`team ${selected.map((slot:number)=>slot+1).join('')}`,features,simpleScore});
    }
  }
  return candidates;
}

export function encode(request: any, view: VisibleState, side: SideId): Encoded {
  const preview = request.teamPreview === true;
  const state = packState(request, view, side, preview);
  if (preview) return {state, candidates:previewCandidates(request)};
  const active = Array.isArray(request.active) ? request.active : [];
  const slots = Math.max(2, active.length, Array.isArray(request.forceSwitch) ? request.forceSwitch.length : 0);
  const perSlot = Array.from({length: slots}, (_, i) => {
    const slot = active[i];
    if (request.forceSwitch?.[i] === true) return moveOptions(slot, i, request, view, side).filter((x:any)=>x.switchSlot !== undefined);
    if (request.forceSwitch && request.forceSwitch[i] === false) return [{choice:'pass',features:emptyComponent('pass'),mega:false,score:0}];
    if (!slot || request.side.pokemon[i]?.condition?.includes('fnt')) return [{choice:'pass',features:emptyComponent('pass'),mega:false,score:0}];
    return moveOptions(slot, i, request, view, side);
  });
  if (!perSlot.length) throw new Error('Actionable Champions request has no active slots');
  const first = perSlot[0] ?? [{choice:'pass',features:emptyComponent('pass'),mega:false,score:0}];
  const second = perSlot[1] ?? [{choice:'pass',features:emptyComponent('pass'),mega:false,score:0}];
  const candidates: Candidate[] = [];
  for (const a of first) for (const b of second) {
    if (a.mega && b.mega) continue;
    if (a.switchSlot !== undefined && a.switchSlot === b.switchSlot) continue;
    const features = new Array<number>(ACTION_DIM).fill(0);
    a.features.forEach((value:number,i:number) => features[i] = value);
    b.features.forEach((value:number,i:number) => features[24 + i] = value);
    const targetA = a.target, targetB = b.target;
    features[48] = Number(targetA !== undefined && targetA === targetB && targetA >= 0);
    features[49] = Number(a.mega || b.mega);
    features[50] = Number(a.features[14] && b.features[14]);
    features[51] = Number(a.switchSlot !== undefined && b.switchSlot !== undefined);
    features[52] = Number(a.features[0] && b.features[0]);
    features[53] = Number((a.features[17] && b.features[0]) || (b.features[17] && a.features[0]));
    features[54] = Number(a.features[15] || b.features[15]);
    features[55] = Number(a.features[0] && b.features[0] && targetA !== targetB);
    candidates.push({choice:`${a.choice}, ${b.choice}`,features,simpleScore:a.score+b.score});
  }
  if (!candidates.length && request.forceSwitch?.filter(Boolean).length === 2) {
    const forcedSlots = [0, 1].filter(i => request.forceSwitch[i] === true);
    const switchSlots = new Set<number>(forcedSlots.flatMap(i => perSlot[i].flatMap((option: any) => option.switchSlot === undefined ? [] : [option.switchSlot])));
    if (switchSlots.size === 1) {
      const onlySwitch = [...switchSlots][0];
      const pass = {choice:'pass',features:emptyComponent('pass'),mega:false,score:0};
      const leadSlot = forcedSlots.find(i => perSlot[i].some((option: any) => option.switchSlot === onlySwitch));
      if (leadSlot !== undefined) {
        const picks = [0, 1].map(i => i === leadSlot
          ? perSlot[i].filter((option: any) => option.switchSlot === onlySwitch)
          : [pass]);
        for (const a of picks[0]) for (const b of picks[1]) {
          const features = new Array<number>(ACTION_DIM).fill(0);
          a.features.forEach((value:number,i:number) => features[i] = value);
          b.features.forEach((value:number,i:number) => features[24 + i] = value);
          candidates.push({choice:`${a.choice}, ${b.choice}`,features,simpleScore:a.score+b.score});
        }
      }
    }
  }
  if (!candidates.length) throw new Error(`No legal joint Champions actions: ${JSON.stringify({forceSwitch:request.forceSwitch,active:request.active?.map((slot:any)=>({moves:slot.moves?.map((m:any)=>({id:m.id,disabled:m.disabled,target:m.target})),trapped:slot.trapped})),team:request.side.pokemon?.map((p:any)=>({active:p.active,condition:p.condition})),perSlot:perSlot.map((options:any[])=>options.map(option=>option.choice))})}`);
  const badState = state.findIndex(value => !Number.isFinite(value));
  const badCandidate = candidates.findIndex(candidate => candidate.features.length !== ACTION_DIM || candidate.features.some(value => !Number.isFinite(value)));
  if (badState >= 0 || badCandidate >= 0) {
    const candidate = candidates[badCandidate];
    throw new Error(`Nonfinite Champions feature for ${side} on turn ${view.turn}: stateIndex=${badState}, candidateIndex=${badCandidate}, choice=${candidate?.choice}, featureIndex=${candidate?.features.findIndex(value => !Number.isFinite(value))}`);
  }
  return {state,candidates};
}

export function heuristic(encoded: Encoded) {
  let best = 0;
  for (let i = 1; i < encoded.candidates.length; i++) if (encoded.candidates[i].simpleScore > encoded.candidates[best].simpleScore) best = i;
  return best;
}
