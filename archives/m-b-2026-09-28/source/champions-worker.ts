import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import showdown from 'pokemon-showdown';
import {ACTION_DIM, CHAMPIONS_ENGINE_VERSION, CHAMPIONS_FORMAT, encode, heuristic, STATE_DIM, VisibleState, type Candidate, type Encoded, type SideId} from './champions.js';

const {BattleStream, getPlayerStreams, Teams, TeamValidator, Dex, toID} = showdown;
const itemPool = Dex.forFormat(CHAMPIONS_FORMAT).items.all()
  .filter(item => item.exists && !item.isNonstandard && !item.megaStone && !item.zMove)
  .map(item => item.name);
const validator = new TeamValidator(CHAMPIONS_FORMAT);
const opponent: Record<SideId, SideId> = {p1: 'p2', p2: 'p1'};

export function makeTeam(seed: number[]) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const teamSeed = [...seed];
    teamSeed[3] = (teamSeed[3] + attempt) & 65535;
    const team = Teams.generate(CHAMPIONS_FORMAT, {seed: teamSeed});
    const used = new Set<string>();
    for (const pokemon of team) {
      if (used.has(toID(pokemon.item))) {
        const replacement = itemPool.find(item => !used.has(toID(item)));
        if (!replacement) throw new Error('No unused legal item remains for Champions Item Clause');
        pokemon.item = replacement;
      }
      used.add(toID(pokemon.item));
    }
    const errors = validator.validateTeam(team);
    if (!errors) return Teams.pack(team);
  }
  throw new Error(`Could not generate a legal Champions team after 100 deterministic seeds from ${seed.join(',')}`);
}

type Tensor = number[] | number[][];
export interface Checkpoint {
  schema: number; format: string; engineVersion: string; stateDim: number; actionDim: number;
  steps: number; selfPlayBattlesGenerated: number; simpleScoreWeight?: number;
  weights: Record<string, Tensor>;
}
function dense(x: number[], weights: number[][], bias: number[], tanh = false) {
  return weights.map((row, i) => {
    let value = bias[i];
    for (let j = 0; j < x.length; j++) value += x[j] * row[j];
    return tanh ? Math.tanh(value) : value;
  });
}
export class Policy {
  constructor(readonly checkpoint: Checkpoint) {
    if (checkpoint.schema !== 1 || checkpoint.format !== CHAMPIONS_FORMAT || checkpoint.engineVersion !== CHAMPIONS_ENGINE_VERSION || checkpoint.stateDim !== STATE_DIM || checkpoint.actionDim !== ACTION_DIM) throw new Error('Incompatible Champions checkpoint');
    const dims: Record<string, [number, number?]> = {'state.weight':[64,STATE_DIM], 'state.bias':[64], 'action.weight':[ACTION_DIM,64], 'action.bias':[ACTION_DIM], 'critic.weight':[1,64], 'critic.bias':[1]};
    for (const [name, [rows, cols]] of Object.entries(dims)) {
      const data = checkpoint.weights[name];
      if (!Array.isArray(data) || data.length !== rows || (cols && data.some(row => !Array.isArray(row) || row.length !== cols)) || data.flat().some(x => typeof x !== 'number' || !Number.isFinite(x))) throw new Error(`Invalid checkpoint tensor ${name}`);
    }
  }
  predict(encoded: Encoded, simpleScoreWeight?: number) {
    const w = this.checkpoint.weights;
    const scoreWeight = simpleScoreWeight ?? this.checkpoint.simpleScoreWeight ?? 0;
    const hidden = dense(encoded.state, w['state.weight'] as number[][], w['state.bias'] as number[], true);
    const context = dense(hidden, w['action.weight'] as number[][], w['action.bias'] as number[]);
    const logits = encoded.candidates.map(candidate =>
      candidate.features.reduce((n, x, i) => n + x * context[i], 0) + scoreWeight * candidate.simpleScore);
    if (logits.some(value => !Number.isFinite(value))) throw new Error('Nonfinite Champions policy logit');
    const max = Math.max(...logits), exps = logits.map(x => Math.exp(x - max)), sum = exps.reduce((a,b) => a+b, 0);
    if (!Number.isFinite(sum) || sum <= 0) throw new Error('Invalid Champions policy probability normalization');
    return {probabilities: exps.map(x => x / sum), value: dense(hidden, w['critic.weight'] as number[][], w['critic.bias'] as number[])[0]};
  }
  choose(encoded: Encoded, random: () => number, simpleScoreWeight?: number) {
    const prediction = this.predict(encoded, simpleScoreWeight);
    let threshold = random(), action = encoded.candidates.length - 1;
    for (let i = 0; i < prediction.probabilities.length; i++) {
      threshold -= prediction.probabilities[i];
      if (threshold < 0) { action = i; break; }
    }
    return {action, logp: Math.log(Math.max(1e-30, prediction.probabilities[action])), value: prediction.value};
  }
}

interface Step {state: number[]; actions: number[][]; simpleScores: number[]; action: number; logp: number; value: number}
interface Episode {steps: Step[]; reward: number; side: SideId}
interface GameResult {winner: SideId | null; turns: number; truncated: boolean; retries: number; episodes: Episode[]}
function prng(seed: number) {
  const rng = new showdown.PRNG(`41,53,${(seed >>> 16) & 65535},${seed & 65535}`);
  return () => rng.random();
}

export interface Choice {action: number; logp: number; value: number; choice: string}
export async function play(seed: number, choose: (side: SideId, encoded: Encoded) => Choice, maxTurns = 200, trace = false): Promise<GameResult> {
  const stream = new BattleStream();
  const streams = getPlayerStreams(stream);
  const lo = seed & 65535, hi = (seed >>> 16) & 65535;
  const teams = [makeTeam([71,89,hi,lo]), makeTeam([72,89,hi,lo])];
  const trajectories: Record<SideId, Step[]> = {p1: [], p2: []};
  const views: Record<SideId, VisibleState> = {p1: new VisibleState(), p2: new VisibleState()};
  const requestKeys: Record<SideId, string> = {p1: '', p2: ''};
  const rejectedParts: Record<SideId, Set<string>> = {p1: new Set(), p2: new Set()};
  const lastChoices: Partial<Record<SideId, {choice:string; requestKey:string; active:any[]}>> = {};
  let winner: SideId | null = null, turns = 0, ended = false, truncated = false, retries = 0;
  const traceCount: Record<SideId, number> = {p1: 0, p2: 0};
  let finishDecisions!: () => void;
  const terminal = new Promise<void>(resolve => {finishDecisions = resolve;});
  const jobs: Promise<unknown>[] = (['p1','p2'] as SideId[]).map(async side => {
    for await (const chunk of streams[side]) for (const line of chunk.split('\n')) {
      if (line.startsWith('|error|')) {
        const last = lastChoices[side];
        if (!line.includes('[Unavailable choice]') && !line.includes('[Invalid choice]')) throw new Error(`Simulator error for ${side}: ${line}`);
        if (!last) throw new Error(`Choice error without a recorded decision for ${side}: ${line}`);
        if (line.includes('[Invalid choice]')) {
          console.error(JSON.stringify({trace:'invalid-choice-details',seed,side,choice:last.choice,activeCount:last.active.length,
            activeMoves:last.active.map((slot:any) => slot?.moves?.map((move:any) => ({id:move.id,target:move.target,disabled:move.disabled})) ?? []),line}));
          throw new Error(`Generated an invalid Champions choice; preserving the failed battle in the ledger: ${line}`);
        }
        retries++; trajectories[side].pop();
        if (last.requestKey === requestKeys[side]) {
          for (const part of last.choice.split(',').map(value => value.trim())) rejectedParts[side].add(part);
        }
        lastChoices[side] = undefined;
        if (trace || line.includes('[Invalid choice]')) console.error(JSON.stringify({trace:'rejected-choice',seed,side,choice:last.choice,line}));
        if (retries > 50) throw new Error(`Too many rejected choices in Champions battle ${seed}`);
        continue;
      }
      if (line.startsWith('|request|')) {
        const request = JSON.parse(line.slice(9));
        if (request.wait || ended) continue;
        const requestKey = JSON.stringify(request);
        if (requestKey !== requestKeys[side]) {
          requestKeys[side] = requestKey;
          rejectedParts[side].clear();
        }
        const encoded = encode(request, views[side], side);
        if (rejectedParts[side].size) {
          encoded.candidates = encoded.candidates.filter(candidate => !candidate.choice.split(',').some(part => rejectedParts[side].has(part.trim())));
          if (!encoded.candidates.length) throw new Error(`All encoded choices were rejected for ${side}: ${[...rejectedParts[side]].join('; ')}`);
        }
        const result = choose(side, encoded);
        lastChoices[side] = {choice:result.choice, requestKey, active:request.active ?? []};
        if (trace && traceCount[side]++ < 40) console.error(JSON.stringify({trace:'choice',seed,side,turn:views[side].turn,teamPreview:!!request.teamPreview,candidates:encoded.candidates.length,action:result.action,logp:result.logp,choice:result.choice}));
      trajectories[side].push({state: encoded.state, actions: encoded.candidates.map(c => c.features),
        simpleScores: encoded.candidates.map(c => c.simpleScore), action: result.action, logp: result.logp, value: result.value});
        await streams[side].write(result.choice);
      } else views[side].receive(line);
    }
  });
  jobs.push((async () => {
    for await (const chunk of streams.spectator) for (const line of chunk.split('\n')) {
      if (line.startsWith('|turn|')) {
        turns = Number(line.slice(6));
        if (turns >= maxTurns && !truncated) {truncated = true; await stream.write('>forcetie');}
      }
      if (line.startsWith('|win|')) {winner = line.slice(5) as SideId; ended = true; finishDecisions();}
      if (line === '|tie' || line === '|tie|') {ended = true; finishDecisions();}
    }
  })());
  for (const side of ['omniscient','p3','p4'] as const) jobs.push((async () => {for await (const _ of streams[side]) { /* discard unused channels */ }})());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const setup = (['p1','p2'] as SideId[]).map((side, i) => `>player ${side} ${JSON.stringify({name: side, team: teams[i], seed: [101+i,127,hi,lo].join(',')})}`).join('\n');
    timer = setTimeout(() => stream.pushError(new Error(`Champions battle ${seed} exceeded 30 seconds`)), 30000);
    await stream.write(`>start ${JSON.stringify({formatid: CHAMPIONS_FORMAT, seed: [17,29,hi,lo]})}\n${setup}`);
    await Promise.all(jobs);
    if (!ended) throw new Error('Simulator ended without a terminal result');
    const episodes = (['p1','p2'] as SideId[]).map(side => ({steps: trajectories[side], reward: winner === side ? 1 : winner ? -1 : 0, side}));
    return {winner, turns, truncated, retries, episodes};
  } finally {
    if (timer) clearTimeout(timer);
    finishDecisions();
    await stream.writeEnd();
    for (const job of jobs) void job.catch(() => {});
  }
}

export async function collect(model: Policy, args: {games: number; seed: number; opponent?: 'selfplay'|'heuristic'|'random'; maxTurns?: number; debug?: boolean; onBattleStart?: (seed: number, opponent: string) => void; onBattleEnd?: (seed: number, opponent: string, completed: boolean, truncated: boolean) => void}) {
  if (!Number.isInteger(args.games) || args.games < 1 || !Number.isInteger(args.seed) || args.seed < 0) throw new Error('Invalid self-play batch size or seed');
  const opponentType = args.opponent ?? 'selfplay';
  const episodes: Episode[] = [];
  let completed = 0, attempts = 0, truncated = 0, retries = 0;
  for (let i = 0; completed < args.games; i++) {
    attempts++;
    args.onBattleStart?.(args.seed + i, opponentType);
    const rngs: Record<SideId, () => number> = {p1: prng(args.seed + i * 2), p2: prng(args.seed + i * 2 + 1)};
    const learnerSide: SideId = opponentType === 'selfplay' ? 'p1' : ((args.seed + i) % 2 ? 'p1' : 'p2');
    const result = await play(args.seed + i, (side, encoded) => {
      let prediction: {action:number;logp:number;value:number};
      if (opponentType === 'selfplay' || side === learnerSide) prediction = model.choose(encoded, rngs[side]);
      else if (opponentType === 'heuristic') prediction = {action:heuristic(encoded),logp:0,value:0};
      else prediction = {action:Math.floor(rngs[side]() * encoded.candidates.length),logp:0,value:0};
      const candidate = encoded.candidates[prediction.action];
      return {...prediction, choice: candidate.choice};
    }, args.maxTurns, args.debug);
    retries += result.retries;
    if (result.truncated) {
      truncated++;
      args.onBattleEnd?.(args.seed + i, opponentType, false, true);
      if (args.debug || truncated >= 3) break;
      continue;
    }
    if (result.episodes.some(episode => !episode.steps.length)) throw new Error(`Empty self-play trajectory in battle ${args.seed+i}`);
    completed++;
    episodes.push(...result.episodes.filter(episode => opponentType === 'selfplay' || episode.side === learnerSide));
    args.onBattleEnd?.(args.seed + i, opponentType, true, false);
  }
  return {episodes, attempts, completed, truncated, retries, turnsRemaining: args.games - completed};
}

async function main() {
  for await (const raw of createInterface({input: process.stdin, crlfDelay: Infinity})) {
    const message = JSON.parse(raw);
    const model = new Policy(message.model as Checkpoint);
    if (message.command === 'predict') {
      const fake = {state: message.encoded.state, candidates: message.encoded.actions.map((features: number[], index: number) => ({
        choice:'',features,simpleScore:message.encoded.simpleScores?.[index] ?? 0}))} as Encoded;
      console.log(JSON.stringify(model.predict(fake))); continue;
    }
    if (message.command !== 'collect') throw new Error(`Unknown Champions worker command: ${message.command}`);
    const progress = {
      onBattleStart: (seed: number, opponent: string) => console.log(JSON.stringify({event:'battle-started',seed,opponent})),
      onBattleEnd: (seed: number, opponent: string, completed: boolean, truncated: boolean) => console.log(JSON.stringify({event:'battle-finished',seed,opponent,completed,truncated})),
    };
    console.log(JSON.stringify(await collect(model, {...message, ...progress})));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {console.error(error); process.exit(1);});
