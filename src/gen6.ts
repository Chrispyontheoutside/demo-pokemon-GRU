import showdown from 'pokemon-showdown';
import type { Side } from './contracts.js';

export const GEN6 = 'gen6randombattle';
export const SCHEMA = 1;
const dex = showdown.Dex.mod('gen6');
const TYPES = ['Normal','Fire','Water','Electric','Grass','Ice','Fighting','Poison','Ground','Flying','Psychic','Bug','Rock','Ghost','Dragon','Dark','Steel','Fairy'];
const STATS = ['atk','def','spa','spd','spe','accuracy','evasion'];
const STATUSES = ['brn','par','slp','frz','psn','tox'];
const FIELDS = ['stealthrock','spikes','toxicspikes','stickyweb','reflect','lightscreen','safeguard','tailwind'];
const id = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const key = (s: string) => s.replace(/^p([12])[a-z]:/, 'p$1:');
export interface RequestPokemon {
  ident: string; details: string; condition: string; active: boolean;
  stats: Record<string, number>; moves: string[]; baseAbility: string; item: string;
}
export interface Gen6Request {
  wait?: boolean; teamPreview?: boolean; forceSwitch?: boolean[];
  side: { pokemon: RequestPokemon[] };
  active?: { moves: {id: string; move: string; pp?: number; maxpp?: number; disabled?: boolean | string}[]; trapped?: boolean; canMegaEvo?: boolean }[];
}
interface VisibleMon {
  ident: string; details: string; condition: string; types: string[];
  boosts: Record<string, number>; ability: string; item: string; moves: string[];
}
export function hp(condition: string): number {
  if (condition.includes('fnt') || condition === '0') return 0;
  const match = /^(\d+)\/(\d+)/.exec(condition);
  return match ? Math.min(1, Number(match[1]) / Number(match[2])) : 0;
}
function types(details: string) { return dex.species.get(details.split(',')[0]).types; }
function mon(ident: string, details: string, condition: string): VisibleMon {
  return { ident, details, condition, types: types(details), boosts: {}, ability: '', item: '', moves: [] };
}
export class VisibleState {
  turn = 0;
  readonly teams: Record<Side, Map<string, VisibleMon>> = {p1: new Map(), p2: new Map()};
  readonly active: Partial<Record<Side, VisibleMon>> = {};
  readonly field: Record<Side, Set<string>> = {p1: new Set(), p2: new Set()};
  weather = ''; trickRoom = false;
  receive(line: string) {
    const [,cmd,who = '',a = '',b = ''] = line.split('|');
    const side = who.slice(0, 2) as Side;
    const current = this.teams[side]?.get(key(who));
    if (cmd === 'turn') this.turn = Number(who);
    if (['switch','drag','replace'].includes(cmd) && this.teams[side]) {
      // Illusion replacement updates the displayed active; discard the disguised identity.
      if (cmd === 'replace' && this.active[side]) this.teams[side].delete(key(this.active[side]!.ident));
      const next = this.teams[side].get(key(who)) ?? mon(who, a, b);
      Object.assign(next, {ident: who, details: a, condition: b, types: types(a), boosts: {}});
      this.teams[side].set(key(who), next); this.active[side] = next;
    }
    if (current) {
      if (['-damage','-heal','-sethp'].includes(cmd)) current.condition = a;
      if (cmd === 'faint') current.condition = '0 fnt';
      if (cmd === '-status') current.condition = current.condition.split(' ')[0] + ' ' + a;
      if (cmd === '-curestatus') current.condition = current.condition.split(' ')[0];
      if (cmd === '-boost' || cmd === '-unboost') current.boosts[a] = Math.max(-6, Math.min(6, (current.boosts[a] ?? 0) + Number(b) * (cmd === '-boost' ? 1 : -1)));
      if (cmd === '-setboost') current.boosts[a] = Number(b);
      if (cmd === '-clearboost') current.boosts = {};
      if (cmd === '-clearnegativeboost') for (const stat of STATS) current.boosts[stat] = Math.max(0, current.boosts[stat] ?? 0);
      if (cmd === '-ability') current.ability = id(a);
      if (cmd === '-item') current.item = id(a);
      if (cmd === '-enditem') current.item = '';
      if (cmd === 'move' && !current.moves.includes(id(a))) current.moves.push(id(a));
      if (cmd === 'detailschange' || cmd === '-formechange') { current.details = a; current.types = types(a); }
      if (cmd === '-start' && a === 'typechange') current.types = b.split('/');
      if (cmd === '-end' && a === 'typechange') current.types = types(current.details);
    }
    if (cmd === '-clearallboost') for (const active of Object.values(this.active)) active.boosts = {};
    if (cmd === '-sidestart' && this.field[side]) this.field[side].add(id(a.replace(/^move: /, '')));
    if (cmd === '-sideend' && this.field[side]) this.field[side].delete(id(a.replace(/^move: /, '')));
    if (cmd === '-weather') this.weather = who === 'none' ? '' : id(who);
    if (cmd === '-fieldstart' && who.includes('Trick Room')) this.trickRoom = true;
    if (cmd === '-fieldend' && who.includes('Trick Room')) this.trickRoom = false;
  }
}
export interface Candidate { index: number; choice: string; label: string; detail: string; features: number[] }
export interface Encoded { state: number[]; actions: number[][]; mask: boolean[]; candidates: Candidate[] }
const ACTION_DIM = 32;
export function legalChoices(request: Gen6Request): {index: number; choice: string}[] {
  if (request.wait) return [];
  if (request.teamPreview) throw new Error('Unexpected team preview in Gen 6 Random Battles');
  const result: {index: number; choice: string}[] = [];
  const active = request.active?.[0];
  if (!request.forceSwitch?.some(Boolean) && active) {
    active.moves.forEach((move, slot) => {
      if (move.disabled) return;
      result.push({ index: slot, choice: `move ${slot + 1}` });
      if (active.canMegaEvo) result.push({ index: slot + 4, choice: `move ${slot + 1} mega` });
    });
  }
  if (request.forceSwitch?.some(Boolean) || active && !active.trapped) {
    request.side.pokemon.forEach((pokemon, slot) => {
      if (!pokemon.active && hp(pokemon.condition) > 0) result.push({index: slot + 8, choice: `switch ${slot + 1}`});
    });
  }
  if (!result.length) throw new Error('Actionable Gen 6 request has no legal choice');
  return result;
}
function typeVector(ts: string[]) { return TYPES.map(t => Number(ts.includes(t))); }
function statusVector(condition: string) { return STATUSES.map(s => Number(condition.split(' ')[1] === s)); }
function effectiveness(moveType: string, target?: VisibleMon) {
  if (!target) return 1;
  if (!dex.getImmunity(moveType, target.types)) return 0;
  if (moveType === 'Ground' && target.ability === 'levitate') return 0;
  if (moveType === 'Water' && ['waterabsorb','stormdrain','dryskin'].includes(target.ability)) return 0;
  if (moveType === 'Electric' && ['voltabsorb','lightningrod','motordrive'].includes(target.ability)) return 0;
  if (moveType === 'Fire' && target.ability === 'flashfire') return 0;
  return 2 ** dex.getEffectiveness(moveType, target.types);
}
function activeFeatures(pokemon?: VisibleMon) {
  if (!pokemon) return new Array(33).fill(0);
  return [1, hp(pokemon.condition), ...typeVector(pokemon.types), ...statusVector(pokemon.condition), ...STATS.map(s => (pokemon.boosts[s] ?? 0) / 6)];
}
export function encode(view: VisibleState, request: Gen6Request, side: Side): Encoded {
  const foe: Side = side === 'p1' ? 'p2' : 'p1';
  const own = request.side.pokemon;
  const active = own.find(p => p.active)!;
  const attacker = view.active[side];
  const target = view.active[foe];
  const state = [...activeFeatures(attacker), ...activeFeatures(target)];
  for (let slot = 0; slot < 6; slot++) {
    const p = own[slot];
    state.push(...(p ? [1, hp(p.condition), Number(p.active), Number(p.condition.includes('fnt')), ...typeVector(types(p.details)), ...statusVector(p.condition)] : new Array(28).fill(0)));
  }
  const revealed = [...view.teams[foe].values()].slice(0, 6);
  for (let slot = 0; slot < 6; slot++) {
    const p = revealed[slot];
    state.push(...(p ? [1, hp(p.condition), Number(p === target), Number(p.condition.includes('fnt')), ...typeVector(p.types), ...statusVector(p.condition)] : new Array(28).fill(0)));
  }
  state.push(...FIELDS.map(f => Number(view.field[side].has(f))), ...FIELDS.map(f => Number(view.field[foe].has(f))),
    ...['sunnyday','raindance','sandstorm','hail'].map(w => Number(view.weather === w)), Number(view.trickRoom),
    Math.min(view.turn / 100, 4), Number(!!request.forceSwitch?.some(Boolean)), Number(!!request.active?.[0].canMegaEvo));
  const candidates: Candidate[] = legalChoices(request).map(({index, choice}) => {
    const f = new Array(ACTION_DIM).fill(0);
    let label: string, detail: string;
    if (index < 8) {
      const m = request.active![0].moves[index % 4];
      // Recharge is a mandatory request action, not an entry in the move Dex.
      const move = m.id === 'recharge' ? {...dex.moves.get('splash'), name: 'Recharge'} : dex.moves.get(m.id);
      if (!move.exists) throw new Error(`Unrecognized requested move: ${m.id}`);
      const ownTypes = attacker?.types ?? types(active.details);
      const power = move.basePower || (move.damage ? 70 : 0);
      const accuracy = move.accuracy === true ? 1 : move.accuracy / 100;
      const eff = effectiveness(move.type, target);
      const stab = ownTypes.includes(move.type) ? 1.5 : 1;
      const attack = active.stats?.[move.category === 'Physical' ? 'atk' : 'spa'] ?? 100;
      const boost = attacker?.boosts[move.category === 'Physical' ? 'atk' : 'spa'] ?? 0;
      const multiplier = boost >= 0 ? (2 + boost) / 2 : 2 / (2 - boost);
      f[0] = 1; f[2] = Number(index >= 4); f[3] = power / 150; f[4] = accuracy;
      f[5] = Math.min(4, power * accuracy * stab * eff * attack / 15000 * multiplier);
      f[6] = Number(move.category === 'Status'); f[7] = move.priority / 5;
      f[8] = Number(!!move.heal || move.drain !== undefined) * (1 - hp(active.condition));
      f[9] = Number(!!move.boosts); f[10] = Number(!!move.status); f[11] = Number(!!move.sideCondition);
      f[12] = hp(active.condition); f[13] = (m.pp ?? 1) / Math.max(1, m.maxpp ?? 1);
      typeVector([move.type]).forEach((value, j) => f[j + 14] = value);
      label = `${move.name}${index >= 4 ? ' + Mega' : ''}`;
      detail = `${move.type} · ${move.category} · ${m.pp ?? '—'} PP${power ? ` · ${power} power` : ''}`;
    } else {
      const p = own[index - 8]; f[1] = 1; f[12] = hp(p.condition);
      // Public type matchup proxy; no opponent stats or hidden moves are queried.
      const switchTarget = mon(p.ident, p.details, p.condition);
      f[5] = -(target?.types.reduce((worst, t) => Math.max(worst, effectiveness(t, switchTarget)), 0) ?? 1) / 4;
      f[8] = hp(p.condition) - hp(active.condition);
      typeVector(types(p.details)).forEach((value, j) => f[j + 14] = value);
      label = p.details.split(',')[0]; detail = `${p.condition} · ${types(p.details).join(' / ')}`;
    }
    if (f.some(value => !Number.isFinite(value))) throw new Error(`Nonfinite action features: ${choice}, ${label}, ${JSON.stringify(f)}; request ${JSON.stringify(request.active)}`);
    return {index, choice, label, detail, features: f};
  });
  const actions = Array.from({length: 14}, () => new Array(ACTION_DIM).fill(0));
  const mask = new Array(14).fill(false);
  for (const c of candidates) { actions[c.index] = c.features; mask[c.index] = true; }
  return {state, actions, mask, candidates};
}
export function heuristic(encoded: Encoded): number {
  let best = encoded.candidates[0], score = -Infinity;
  for (const candidate of encoded.candidates) {
    const f = candidate.features;
    const value = f[0] ? 4 * f[5] + 0.2 * f[2] + f[8] + 0.08 * f[9] + 0.05 * f[10] : -3 + f[12] + f[5];
    if (value > score) { score = value; best = candidate; }
  }
  return best.index;
}
export interface Checkpoint {
  schema: number; format: string; engineVersion: string; stateDim: number; actionDim: number;
  steps: number; games: number; algorithm: string;
  weights: Record<string, number[] | number[][]>;
}
function dense(x: number[], weights: number[][], bias: number[], tanh = false): number[] {
  return weights.map((row, i) => {
    let value = bias[i]; for (let j = 0; j < x.length; j++) value += x[j] * row[j];
    return tanh ? Math.tanh(value) : value;
  });
}
export class Policy {
  constructor(readonly checkpoint: Checkpoint) {
    if (checkpoint.schema !== SCHEMA || checkpoint.format !== GEN6 || checkpoint.engineVersion !== '0.11.11' || checkpoint.stateDim !== 426 || checkpoint.actionDim !== ACTION_DIM) throw new Error('Incompatible Gen 6 checkpoint');
    const dims: Record<string, [number, number?]> = {'trunk.weight':[64,426], 'trunk.bias':[64], 'actor.weight':[32,64], 'actor.bias':[32], 'critic.weight':[1,64], 'critic.bias':[1]};
    for (const [name, [rows, cols]] of Object.entries(dims)) {
      const data = checkpoint.weights[name];
      if (!Array.isArray(data) || data.length !== rows || (cols && data.some(row => !Array.isArray(row) || row.length !== cols)) || data.flat().some(x => typeof x !== 'number' || !Number.isFinite(x))) throw new Error(`Invalid checkpoint tensor ${name}`);
    }
  }
  predict(encoded: Encoded) {
    if (encoded.state.length !== this.checkpoint.stateDim) throw new Error(`Observation dimension ${encoded.state.length} does not match checkpoint`);
    const w = this.checkpoint.weights;
    const hidden = dense(encoded.state, w['trunk.weight'] as number[][], w['trunk.bias'] as number[], true);
    const context = dense(hidden, w['actor.weight'] as number[][], w['actor.bias'] as number[]);
    const logits = encoded.actions.map((a,i) => encoded.mask[i] ? a.reduce((v, x, j) => v + x * context[j], 0) : -Infinity);
    const max = Math.max(...logits), exps = logits.map(x => Math.exp(x - max)), total = exps.reduce((a,b) => a+b);
    return {probabilities: exps.map(x => x/total), value: dense(hidden, w['critic.weight'] as number[][], w['critic.bias'] as number[])[0]};
  }
  choose(encoded: Encoded, random: () => number) {
    const prediction = this.predict(encoded);
    let threshold = random(), action = encoded.candidates.at(-1)!.index;
    for (let i = 0; i < 14; i++) { threshold -= prediction.probabilities[i]; if (threshold < 0) { action = i; break; } }
    return {action, logp: Math.log(prediction.probabilities[action]), value: prediction.value};
  }
}
export type Decide = (encoded: Encoded, request: Gen6Request, view: VisibleState) => number | Promise<number>;
export interface GameResult { winner: Side | null; turns: number; truncated: boolean; retries: number }
export async function playGen6(options: {
  seed: number; p1: Decide; p2: Decide; maxTurns?: number; swapTeams?: boolean;
  onLine?: (line: string) => void; onRetry?: (side: Side) => void; signal?: AbortSignal;
}): Promise<GameResult> {
  const stream = new showdown.BattleStream();
  const streams = showdown.getPlayerStreams(stream);
  let winner: Side | null = null, turns = 0, ended = false, truncated = false, retries = 0;
  let stopDecisions!: () => void;
  const terminal = new Promise<number>(resolve => { stopDecisions = () => resolve(-1); });
  const abort = () => { stopDecisions(); stream.pushError(new Error('Battle cancelled')); };
  options.signal?.addEventListener('abort', abort, {once: true});
  const jobs = (['p1', 'p2'] as const).map(async side => {
    const view = new VisibleState();
    for await (const chunk of streams[side]) for (const line of chunk.split('\n')) {
      if (line.startsWith('|error|')) {
        if (!line.includes('[Unavailable choice]')) throw new Error(line);
        retries++; options.onRetry?.(side); continue;
      }
      if (line.startsWith('|request|')) {
        const request = JSON.parse(line.slice(9)) as Gen6Request;
        if (request.wait || ended) continue;
        const encoded = encode(view, request, side);
        const action = await Promise.race([options[side](encoded, request, view), terminal]);
        if (ended || options.signal?.aborted) return;
        const candidate = encoded.candidates.find(c => c.index === action);
        if (!candidate) throw new Error(`Illegal action ${action}`);
        await streams[side].write(candidate.choice);
      } else view.receive(line);
    }
  });
  jobs.push((async () => {
    for await (const chunk of streams.spectator) for (const line of chunk.split('\n')) {
      options.onLine?.(line);
      if (line.startsWith('|turn|')) {
        turns = Number(line.slice(6));
        if (turns >= (options.maxTurns ?? 400) && !truncated) { truncated = true; await stream.write('>forcetie'); }
      }
      if (line.startsWith('|win|')) { winner = line.slice(5) as Side; ended = true; }
      if (line === '|tie' || line === '|tie|') ended = true;
      if (ended) stopDecisions();
    }
  })());
  for (const side of ['omniscient','p3','p4'] as const) jobs.push((async () => { for await (const _ of streams[side]) { /* discard private unused channels */ } })());
  try {
    if (options.signal?.aborted) throw new Error('Battle cancelled');
    const lo = options.seed & 65535, hi = (options.seed >>> 16) & 65535;
    const setup = ['p1','p2'].map((side, i) => `>player ${side} ${JSON.stringify({name: side, seed: [71 + (options.swapTeams ? 1-i : i),89,hi,lo].join(',')})}`).join('\n');
    await stream.write(`>start ${JSON.stringify({formatid: GEN6, seed: [17,29,hi,lo]})}\n${setup}`);
    await Promise.all(jobs);
    if (!ended) throw new Error('Simulator ended without a result');
    return {winner, turns, truncated, retries};
  } finally {
    stopDecisions();
    options.signal?.removeEventListener('abort', abort);
    await stream.writeEnd();
    // Caller owns cancellation of any human-input promise.
    for (const job of jobs) void job.catch(() => {});
  }
}
