// Rollout search over candidate actions using cloned battles (DirectGame). Used to evaluate search vs plain policy and to
// generate search-improved action targets (expert iteration). Nothing here reads hidden information the acting side would not have:
// the opposing side's choice is sampled from a policy, not read from the opposing request.
import {heuristic, type Encoded, type SideId} from './champions.js';
import {guardedAction, humanAction} from './champions-worker.js';
import type {Policy} from './champions-worker.js';
import {DirectGame} from './direct-battle.js';

export type Agent = Policy | 'heuristic' | 'guarded' | 'human';
export type Agents = Record<SideId, Agent>;
const other = (side: SideId): SideId => side === 'p1' ? 'p2' : 'p1';
export const hasVoluntarySwitch = (candidate: {features: number[]}) => candidate.features[1] > 0.5 || candidate.features[25] > 0.5;

/** Chooses and applies one decision for `side`, retrying on simulator rejections (hidden traps) with the refreshed request. */
export function act(game: DirectGame, side: SideId, agent: Agent, random: () => number) {
  let encoded = game.encodeFor(side);
  const rejected = new Set<string>();
  const maxAttempts = encoded.candidates.length + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidates = encoded.candidates.filter(candidate => !rejected.has(candidate.choice));
    if (!candidates.length) throw new Error(`No acceptable choice left for ${side}: ${JSON.stringify(game.lastRejection)}`);
    const sub: Encoded = {...encoded, candidates};
    let index: number, nextHidden: number[] | undefined;
    if (agent === 'heuristic') index = heuristic(sub);
    else if (agent === 'guarded') index = guardedAction(sub, game.requests[side], random);
    else if (agent === 'human') index = humanAction(sub, game.requests[side], random, game.views[side], side);
    else { const pick = agent.choose(sub, random, undefined, game.hidden[side]); index = pick.action; nextHidden = pick.nextHidden; }
    const choice = candidates[index].choice;
    if (game.choose(side, choice)) { if (nextHidden) game.hidden[side] = nextHidden; return choice; }
    rejected.add(choice);
    encoded = game.encodeFor(side);
  }
  throw new Error(`Too many rejected choices for ${side}`);
}

/** Plays `game` (mutating it) until it ends or `maxTurns` turns have passed; returns the outcome for `side` in [-1, 1]. */
export function finish(game: DirectGame, side: SideId, agents: Agents, random: () => number, maxTurns: number) {
  let turns = 0;
  while (!game.ended && turns < maxTurns) {
    for (const s of game.pending()) act(game, s, agents[s], random);
    turns++;
  }
  if (game.ended) return game.winner === side ? 1 : game.winner ? -1 : 0;
  const agent = agents[side];
  if (typeof agent === 'string' || !game.pending().includes(side)) return 0;
  return agent.predict(game.encodeFor(side), undefined, game.hidden[side]).value;   // value-head cutoff
}

export interface SearchConfig {topK: number; switchK: number; randomK: number; rollouts: number; maxTurns: number}
export interface SearchResult {encoded: Encoded; prior: number[]; subset: number[]; q: number[]}

export function searchDecision(game: DirectGame, side: SideId, agents: Agents, random: () => number, config: SearchConfig): SearchResult {
  const encoded = game.encodeFor(side);
  const agent = agents[side];
  const prediction = typeof agent === 'string' ? undefined : agent.predict(encoded, undefined, game.hidden[side]);
  const prior = typeof agent === 'string'
    ? encoded.candidates.map((_, i) => Number(i === heuristic(encoded)))
    : prediction!.probabilities;
  const order = prior.map((p, i) => [p, i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  const chosen = new Set(order.slice(0, config.topK));
  order.filter(i => hasVoluntarySwitch(encoded.candidates[i]) && !chosen.has(i)).slice(0, config.switchK).forEach(i => chosen.add(i));
  const rest = order.filter(i => !chosen.has(i));
  for (let k = 0; k < config.randomK && rest.length; k++) chosen.add(rest.splice(Math.floor(random() * rest.length), 1)[0]);
  const subset = [...chosen];
  const foe = other(side);
  const q = subset.map(index => {
    let total = 0, count = 0;
    for (let r = 0; r < config.rollouts; r++) {
      const trial = game.clone();
      let ok = true;
      for (const s of trial.pending()) {
        if (s === side) {
          ok = trial.choose(side, encoded.candidates[index].choice);
          if (ok && prediction?.hidden) trial.hidden[side] = [...prediction.hidden];
        }
        else act(trial, foe, agents[foe], random);
      }
      if (!ok) return -2;                                   // rejected by the simulator: never preferred
      total += finish(trial, side, agents, random, config.maxTurns); count++;
    }
    return count ? total / count : -2;
  });
  return {encoded, prior, subset, q};
}
