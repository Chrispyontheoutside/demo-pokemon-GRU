import showdown from 'pokemon-showdown';
import {VGC_FIELD_EFFECTS, type SideId, type VisibleState} from './champions.js';

const dex = showdown.Dex.forFormat('gen9championsvgc2026regmc');
const types = ['Normal','Fire','Water','Electric','Grass','Ice','Fighting','Poison','Ground','Flying','Psychic','Bug','Rock','Ghost','Dragon','Dark','Steel','Fairy'];
const boosts = ['atk','def','spa','spd','spe','accuracy','evasion'];
const stats = ['hp','atk','def','spa','spd','spe'] as const;
const statuses = ['brn','par','slp','frz','psn','tox'];
const weather = ['sunnyday','raindance','sandstorm','hail','snow','desolateland','primordialsea','deltastream'];
const terrain = ['electricterrain','grassyterrain','mistyterrain','psychicterrain'];
type Mon = VisibleState['teams'][SideId][number];
const hp = (mon: Mon | undefined) => {
  const match = /^(\d+)\/(\d+)/.exec(mon?.condition ?? '');
  return match ? Number(match[1]) / Number(match[2]) : mon?.condition.includes('fnt') ? 0 : 1;
};
const baseStats = (mon: Mon) => {
  const species = dex.species.get(mon.details.split(',')[0]);
  return stats.map(stat => species.baseStats[stat] / 200);
};
export const HUMAN_KINDS = ['move','protect','fakeout','switch','setup'] as const;
export const HUMAN_CONTEXT_NAMES = ['turn','firstTurn','trickRoom', ...weather, ...terrain,
  ...VGC_FIELD_EFFECTS.map(v => `own:${v}`), ...VGC_FIELD_EFFECTS.map(v => `foe:${v}`),
  'hp', ...statuses, ...boosts.map(v => `ownBoost:${v}`), ...types.map(v => `ownType:${v}`), ...stats.map(v => `ownBase:${v}`), 'allyHp', 'foeMeanHp', 'foeMinHp', 'foeActiveCount',
  ...types.map(v => `foeType:${v}`), ...boosts.map(v => `foeBoost:${v}`), ...stats.map(v => `foeBase:${v}`),
  'ownNotKnownFainted','foeNotKnownFainted'];

/** Public information only, shared by log extraction and synthetic opponent inference. */
export function humanContextFeatures(view: VisibleState, side: SideId, slot: number): number[] {
  const mon = view.active[side].get(`${side}${slot ? 'b' : 'a'}`);
  if (!mon) throw new Error(`Missing public active Pokemon: ${side}, slot ${slot}`);
  const foe: SideId = side === 'p1' ? 'p2' : 'p1';
  const enemies = [...view.active[foe].values()].filter(m => m.active && !m.condition.includes('fnt'));
  const ally = view.active[side].get(`${side}${slot ? 'a' : 'b'}`);
  const average = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const features = [Math.min(1, view.turn / 10), Number(view.turn <= 1), Number(view.trickRoom),
    ...weather.map(v => Number(view.weather === v)), ...terrain.map(v => Number(view.terrain.includes(v))),
    ...VGC_FIELD_EFFECTS.map(v => Number(view.fields[side].has(v))), ...VGC_FIELD_EFFECTS.map(v => Number(view.fields[foe].has(v))),
    hp(mon), ...statuses.map(v => Number(mon.condition.split(' ')[1] === v)), ...boosts.map(v => (mon.boosts[v] ?? 0) / 6),
    ...types.map(v => Number(mon.types.includes(v))), ...baseStats(mon), ally?.active ? hp(ally) : 0,
    average(enemies.map(hp)), enemies.length ? Math.min(...enemies.map(hp)) : 0, enemies.length / 2,
    ...types.map(v => average(enemies.map(m => Number(m.types.includes(v))))),
    ...boosts.map(v => enemies.length ? Math.max(...enemies.map(m => m.boosts[v] ?? 0)) / 6 : 0),
    ...stats.map((_, i) => average(enemies.map(m => baseStats(m)[i]))),
    view.teams[side].filter(m => !m.condition.includes('fnt')).length / 6,
    view.teams[foe].filter(m => !m.condition.includes('fnt')).length / 6];
  if (features.length !== HUMAN_CONTEXT_NAMES.length) throw new Error('Human-context feature contract mismatch');
  return features;
}

export interface HumanContextModel {features: string[]; kinds: string[]; hidden: number; w1: number[][]; b1: number[]; w2: number[][]; b2: number[]}
export function humanContextProbabilities(model: HumanContextModel, features: number[]): number[] {
  const hidden = model.w1.map((weights, i) => Math.tanh(weights.reduce((sum, weight, j) => sum + weight * features[j], model.b1[i])));
  const logits = model.w2.map((weights, i) => weights.reduce((sum, weight, j) => sum + weight * hidden[j], model.b2[i]));
  const maximum = Math.max(...logits), exp = logits.map(value => Math.exp(value - maximum));
  const total = exp.reduce((sum, value) => sum + value, 0);
  return exp.map(value => value / total);
}
