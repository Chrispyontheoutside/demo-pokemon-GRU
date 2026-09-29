// Ladder-side rollout search: reconstruct the battle from our own information (src/reconstruct.ts), roll out candidates against an
// empirical-human opponent model over several determinizations of the opposing sets, and pick from softmax(Q/tau) x policy prior.
import type {Policy} from './champions-worker.js';
import type {Encoded, SideId, VisibleState} from './champions.js';
import {reconstruct} from './reconstruct.js';
import {searchDecision} from './search.js';
import type {Searcher} from './online-champions.js';

export interface LadderSearchConfig {determinizations: number; rollouts: number; topK: number; switchK: number; maxTurns: number; tau: number; budgetMs: number}
export const DEFAULT_LADDER_SEARCH: LadderSearchConfig = {determinizations: 4, rollouts: 3, topK: 8, switchK: 3, maxTurns: 12, tau: 0.1, budgetMs: 40000};

export function makeLadderSearch(policy: Policy, ownPack: string, config: LadderSearchConfig = DEFAULT_LADDER_SEARCH, random: () => number = Math.random): Searcher {
  return (encoded: Encoded, request: any, view: VisibleState, hidden: number[] | undefined) => {
    const side = request.side.id as SideId;
    const started = performance.now();
    const sums = new Map<string, {total: number; count: number}>();
    let built = 0;
    for (let d = 0; d < config.determinizations && performance.now() - started < config.budgetMs; d++) {
      const game = reconstruct({side, request, view, ownPack, random});
      if (!game) continue;
      built++;
      if (hidden) game.hidden[side] = [...hidden];
      const agents = side === 'p1' ? {p1: policy, p2: 'human' as const} : {p1: 'human' as const, p2: policy};
      const result = searchDecision(game, side, agents, random, {topK: config.topK, switchK: config.switchK, randomK: 0, rollouts: config.rollouts, maxTurns: config.maxTurns});
      result.subset.forEach((index, i) => {
        const key = result.encoded.candidates[index].choice;
        const entry = sums.get(key) ?? {total: 0, count: 0};
        entry.total += result.q[i]; entry.count++;
        sums.set(key, entry);
      });
    }
    if (!built) return undefined;
    const prior = policy.predict(encoded, undefined, hidden).probabilities;
    const scored = encoded.candidates.map((candidate, index) => ({index, entry: sums.get(candidate.choice)})).filter(item => item.entry && item.entry.count > 0)
      .map(item => ({index: item.index, q: item.entry!.total / item.entry!.count}));
    if (scored.length < 2) return undefined;
    const top = Math.max(...scored.map(s => s.q));
    const weights = scored.map(s => Math.exp((s.q - top) / config.tau) * (0.01 + prior[s.index]));
    let draw = random() * weights.reduce((a, b) => a + b, 0), pick = scored[scored.length - 1];
    for (let i = 0; i < scored.length; i++) { draw -= weights[i]; if (draw <= 0) { pick = scored[i]; break; } }
    return {action: pick.index, note: {searched: scored.length, built, ms: Math.round(performance.now() - started), q: +pick.q.toFixed(3), best: +top.toFixed(3)}};
  };
}
