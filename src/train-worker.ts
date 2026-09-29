import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import showdown from 'pokemon-showdown';
import {Policy, playGen6, heuristic, type Encoded, type Checkpoint, type GameResult} from './gen6.js';

interface Step {state: number[]; actions: number[][]; mask: boolean[]; action: number; logp: number; value: number}
function rng(seed: number) { const p = new showdown.PRNG(`41,53,${seed >>> 16},${seed & 65535}`); return () => p.random(); }
export async function evaluate(model: Policy, pairs: number, startSeed: number, opponent: 'random' | 'heuristic' | Policy, opponentName = 'checkpoint') {
  let wins=0, losses=0, draws=0, truncated=0, retries=0;
  const pairScores: number[] = [];
  for (let i=0; i<pairs; i++) {
    let pairScore=0;
    for (const swap of [false,true]) {
      const random = rng(startSeed+i), other = rng(startSeed+i+7);
      const agent = (e: Encoded) => model.choose(e,random).action;
      const baseline = (e: Encoded) => opponent instanceof Policy ? opponent.choose(e,other).action : opponent === 'heuristic' ? heuristic(e) : e.candidates[Math.floor(other()*e.candidates.length)].index;
      // Keep generated teams attached to their slots; swapping policies gives the
      // learner the OTHER team and seat in the second game.
      const result = await playGen6({seed: startSeed+i, p1: swap ? baseline : agent, p2: swap ? agent : baseline});
      retries += result.retries;
      if (result.truncated) {truncated++; continue;}
      if (result.winner === (swap ? 'p2' : 'p1')) {wins++; pairScore++;}
      else if (result.winner) losses++;
      else {draws++; pairScore+=0.5;}
    }
    pairScores.push(pairScore/2);
  }
  return {opponent: opponent instanceof Policy ? opponentName : opponent, pairs, startSeed, wins, losses, draws, truncated, retries, pairScores};
}
export async function collect(model: Policy, message: {steps: number; seed: number; teacher?: boolean; selfPlay?: boolean; maxGames?: number; maxTurns?: number}) {
  if (!Number.isInteger(message.steps) || message.steps < 1 || !Number.isInteger(message.seed) || message.seed < 0) throw new Error('Invalid rollout size or seed');
  if (message.maxGames !== undefined && (!Number.isInteger(message.maxGames) || message.maxGames < 1)) throw new Error('Invalid completed-game limit');
  if (message.teacher && message.selfPlay) throw new Error('Imitation and self-play are separate modes');
  const episodes: {steps: Step[]; reward: number}[] = [];
  let steps=0, games=0, completed=0, discarded=0, retries=0;
  while (steps < message.steps && completed < (message.maxGames ?? Infinity)) {
    const trajectories: Record<'p1' | 'p2', Step[]> = {p1: [], p2: []};
    const seed = message.seed + games;
    if (seed > 0xffffffff) throw new Error('Simulator seed range exhausted');
    const random = {p1: rng(seed), p2: rng(seed+1)};
    const act = (side: 'p1' | 'p2', encoded: Encoded) => {
      const prediction = model.choose(encoded, random[side]);
      const action = message.teacher ? heuristic(encoded) : prediction.action;
      trajectories[side].push({state: encoded.state, actions: encoded.actions, mask: encoded.mask, action, logp: prediction.logp, value: prediction.value});
      return action;
    };
    const result: GameResult = await playGen6({seed, maxTurns: message.maxTurns,
      p1: encoded => act('p1', encoded),
      p2: encoded => message.selfPlay ? act('p2', encoded) : seed % 5 === 0 ? encoded.candidates[Math.floor(random.p2()*encoded.candidates.length)].index : heuristic(encoded),
      onRetry: side => { trajectories[side].pop(); },
    });
    games++; retries+=result.retries;
    // Full episodes; capped attempts consume a seed but never count toward completed games.
    if (result.truncated) { discarded++; if (discarded > 20) throw new Error('Too many truncated training games'); continue; }
    completed++;
    for (const side of (message.selfPlay ? ['p1','p2'] : ['p1']) as ('p1' | 'p2')[]) {
      const episode = trajectories[side];
      if (!episode.length) throw new Error('Completed battle has an empty player trajectory');
      episodes.push({steps: episode, reward: result.winner === side ? 1 : result.winner ? -1 : 0});
      steps+=episode.length;
    }
  }
  return {episodes, steps, games, completed, discarded, retries};
}
async function main() {
  for await (const raw of createInterface({input: process.stdin, crlfDelay: Infinity})) {
    const message = JSON.parse(raw);
    const model = new Policy(message.model as Checkpoint);
    if (message.command === 'predict') { console.log(JSON.stringify(model.predict(message.encoded))); continue; }
    if (message.command === 'evaluate') {
      const opponent = message.opponentModel ? new Policy(message.opponentModel) : message.opponent;
      console.log(JSON.stringify(await evaluate(model,message.pairs,message.seed,opponent,message.opponent))); continue;
    }
    if (message.command !== 'collect') throw new Error('Unknown learner worker command');
    console.log(JSON.stringify(await collect(model, message)));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {console.error(error); process.exitCode=1;});
