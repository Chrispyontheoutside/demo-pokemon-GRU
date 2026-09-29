// Ladder-side rollout search: reconstruct the battle from our own information (src/reconstruct.ts), roll out candidates against an
// empirical-human opponent model over several determinizations of the opposing sets, and pick from softmax(Q/tau) x policy prior.
import type {Policy} from './champions-worker.js';
import type {Encoded, SideId, VisibleState} from './champions.js';
import {reconstruct, guessFoePack} from './reconstruct.js';
import {DirectGame} from './direct-battle.js';
import {finish, searchDecision} from './search.js';
import type {Searcher} from './online-champions.js';

export interface LadderSearchConfig {determinizations: number; rollouts: number; topK: number; switchK: number; maxTurns: number; tau: number; budgetMs: number; previewCandidates: number; previewDeterminizations: number; previewRollouts: number}
export const DEFAULT_LADDER_SEARCH: LadderSearchConfig = {determinizations: 4, rollouts: 3, topK: 8, switchK: 3, maxTurns: 12, tau: 0.1, budgetMs: 40000, previewCandidates: 12, previewDeterminizations: 3, previewRollouts: 3};

export function makeLadderSearch(policy: Policy, ownPack: string, config: LadderSearchConfig = DEFAULT_LADDER_SEARCH, random: () => number = Math.random): Searcher {
  const previewSearch = (encoded: Encoded, request: any, view: VisibleState): {action: number; note?: any} | undefined => {
    const side = request.side.id as SideId, foe: SideId = side === 'p1' ? 'p2' : 'p1';
    const started = performance.now();
    const prior = policy.predict(encoded, undefined, undefined).probabilities;
    const order = prior.map((p, i) => [p, i] as const).sort((a, b) => b[0] - a[0]);
    // Candidate previews: top by prior plus one representative per distinct lead pair (leads dominate the outcome; back order barely matters).
    const seenLeads = new Set<string>(), candidates: number[] = [];
    for (const [, i] of order) {
      const lead = encoded.candidates[i].choice.replace('team ', '').slice(0, 2).split('').sort().join('') + '|' + encoded.candidates[i].choice.replace('team ', '').split('').sort().join('');
      if (seenLeads.has(lead)) continue;
      seenLeads.add(lead); candidates.push(i);
      if (candidates.length >= config.previewCandidates) break;
    }
    const sums = new Map<number, {total: number; count: number}>();
    for (let d = 0; d < config.previewDeterminizations && performance.now() - started < config.budgetMs; d++) {
      const foePack = guessFoePack(view, foe, random);
      if (!foePack) continue;
      const foeSets = foePack;
      for (const index of candidates) {
        for (let r = 0; r < config.previewRollouts; r++) {
          const game = DirectGame.create(side === 'p1' ? [ownPack, foeSets] : [foeSets, ownPack], [Math.floor(random() * 65536), Math.floor(random() * 65536), d, r]);
          const foeBring = [0, 1, 2, 3, 4, 5].sort(() => random() - 0.5).slice(0, 4).map(n => n + 1).join('');
          if (!game.choose(side, encoded.candidates[index].choice) || !game.choose(foe, `team ${foeBring}`)) continue;
          const agents = side === 'p1' ? {p1: policy, p2: 'human' as const} : {p1: 'human' as const, p2: policy};
          const rolloutRandom = () => random();
          const value = finish(game, side, agents, rolloutRandom, 40);
          const entry = sums.get(index) ?? {total: 0, count: 0};
          entry.total += value; entry.count++; sums.set(index, entry);
        }
      }
    }
    const scored = [...sums.entries()].filter(([, e]) => e.count > 0).map(([index, e]) => ({index, q: e.total / e.count}));
    if (scored.length < 2) return undefined;
    const top = Math.max(...scored.map(s => s.q));
    const weights = scored.map(s => Math.exp((s.q - top) / config.tau) * (0.01 + prior[s.index]));
    let draw = random() * weights.reduce((a, b) => a + b, 0), pick = scored[scored.length - 1];
    for (let i = 0; i < scored.length; i++) { draw -= weights[i]; if (draw <= 0) { pick = scored[i]; break; } }
    return {action: pick.index, note: {preview: true, searched: scored.length, ms: Math.round(performance.now() - started), q: +pick.q.toFixed(3), best: +top.toFixed(3), choice: encoded.candidates[pick.index].choice}};
  };
  return (encoded: Encoded, request: any, view: VisibleState, hidden: number[] | undefined) => {
    const side = request.side.id as SideId;
    if (request.teamPreview) return config.previewCandidates > 0 ? previewSearch(encoded, request, view) : undefined;
    const started = performance.now();
    const sums = new Map<string, {total: number; count: number}>();
    let built = 0;
    for (let d = 0; d < config.determinizations && performance.now() - started < config.budgetMs; d++) {
      const game = reconstruct({side, request, view, ownPack, random});
      if (!game) continue;
      built++;
      if (hidden) game.hidden[side] = [...hidden];
      const agents = side === 'p1' ? {p1: policy, p2: 'human' as const} : {p1: 'human' as const, p2: policy};
      const detRandom = () => random();          // a fresh RNG identity per determinization, so each samples its own human style
      const result = searchDecision(game, side, agents, detRandom, {topK: config.topK, switchK: config.switchK, randomK: 0, rollouts: config.rollouts, maxTurns: config.maxTurns});
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
