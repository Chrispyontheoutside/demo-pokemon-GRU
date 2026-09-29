import {readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import showdown from 'pokemon-showdown';
import {ACTION_DIM, CHAMPIONS_ENGINE_VERSION, CHAMPIONS_FORMAT, encode, heuristic, potential, STATE_DIM, VisibleState, type Candidate, type Encoded, type SideId} from './champions.js';

const {BattleStream, getPlayerStreams, Teams, TeamValidator, Dex, toID} = showdown;
export const CHAMPIONS_TEAM_GENERATOR_VERSION = 'm-c-statpoints-v1';
const itemPool = Dex.forFormat(CHAMPIONS_FORMAT).items.all()
  .filter(item => item.exists && !item.isNonstandard && !item.megaStone && !item.zMove)
  .map(item => item.name);
const validator = new TeamValidator(CHAMPIONS_FORMAT);
const formatDex = Dex.forFormat(CHAMPIONS_FORMAT);
const legacyRegMDex = Dex.forFormat('gen9championsvgc2026regmb');
const newMCPokemon = formatDex.species.all().filter(species =>
  species.exists && !species.isNonstandard && legacyRegMDex.species.get(species.id).isNonstandard
).map(species => ({
  species: species.isMega ? formatDex.species.get(species.baseSpecies) : species,
  item: species.isMega ? species.requiredItem : undefined,
}));
const opponent: Record<SideId, SideId> = {p1: 'p2', p2: 'p1'};

/** Cumulative synchronous-section timings for throughput benchmarking; never read by training logic. */
export const profile = {encodeMs: 0, encodeCalls: 0, chooseMs: 0, chooseCalls: 0, policyParseMs: 0, policyParseCalls: 0};

function optimizeStatPoints(team: any[]) {
  for (const set of team) {
    const species = formatDex.species.get(set.species);
    const stats = species.baseStats;
    let physical = 0, special = 0;
    for (const moveName of set.moves ?? []) {
      const move = formatDex.moves.get(moveName);
      const power = Number(move.basePower) || (move.damage || move.damageCallback ? 60 : 0);
      const accuracy = move.accuracy === true || move.accuracy == null ? 1 : Number(move.accuracy) / 100;
      const value = power * accuracy;
      if (move.category === 'Physical') physical += value;
      if (move.category === 'Special') special += value;
    }
    const evs = {hp: 2, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};
    if (physical || special) {
      const isPhysical = physical >= special;
      const main = isPhysical ? 'atk' : 'spa';
      const other = isPhysical ? 'spa' : 'atk';
      const total = physical + special;
      const mixed = total > 0 && Math.min(physical, special) / total >= 0.28;
      const trickRoom = (set.moves ?? []).some((move: string) => toID(move) === 'trickroom');
      if (trickRoom && Number(stats.spe) < 45) {
        evs.hp = 32;
        evs[main] = 32;
        evs.def = 2;
        set.nature = isPhysical ? 'Brave' : 'Quiet';
      } else {
        evs.spe = 32;
        evs[main] = mixed ? 24 : 32;
        if (mixed) evs[other] = 8;
        set.nature = isPhysical
          ? (Number(stats.spe) >= 105 ? 'Adamant' : 'Jolly')
          : (Number(stats.spe) >= 105 ? 'Modest' : 'Timid');
      }
    } else {
      evs.hp = 32;
      const defense = Number(stats.def) <= Number(stats.spd) ? 'def' : 'spd';
      evs[defense] = 17;
      evs[defense === 'def' ? 'spd' : 'def'] = 17;
      set.nature = defense === 'def' ? 'Bold' : 'Calm';
    }
    set.evs = evs;
  }
}

export function packValidatedTeam(team: any[]) {
  optimizeStatPoints(team);
  const errors = validator.validateTeam(team);
  if (errors) throw new Error(`M-C stat-point team optimization produced an illegal team: ${errors.join('; ')}`);
  return Teams.pack(team);
}

export function makeTeam(seed: number[]) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const teamSeed = [...seed];
    teamSeed[3] = (teamSeed[3] + attempt) & 65535;
    const team = Teams.generate(CHAMPIONS_FORMAT, {seed: teamSeed});
    const enforceItemClause = () => {
      const used = new Set<string>();
      for (const pokemon of team) {
        if (used.has(toID(pokemon.item))) {
          const replacement = itemPool.find(item => !used.has(toID(item)));
          if (!replacement) throw new Error('No unused legal item remains for Champions Item Clause');
          pokemon.item = replacement;
        }
        used.add(toID(pokemon.item));
      }
    };
    enforceItemClause();
    if (validator.validateTeam(team)) continue;

    const random = new showdown.PRNG(`${teamSeed[0]},${teamSeed[1]},${teamSeed[2]},${teamSeed[3]}`);
    if (newMCPokemon.length && random.random() < 0.25) {
      const present = new Set(team.map(pokemon => formatDex.species.get(pokemon.species).baseSpecies));
      const candidates = newMCPokemon.filter(candidate => !present.has(candidate.species.baseSpecies));
      if (candidates.length) {
        const candidate = candidates[Math.floor(random.random() * candidates.length)];
        const species = candidate.species;
        const moves = [...new Set(formatDex.species.getFullLearnset(species.id).flatMap(entry => Object.keys(entry.learnset)))]
          .filter(move => {
            const data = formatDex.moves.get(move);
            return data.exists && !data.isNonstandard && !data.isZ && !data.isMax;
          });
        if (moves.length >= 4) {
          const slot = team.findIndex(pokemon => formatDex.species.get(pokemon.species).baseSpecies === species.baseSpecies);
          const teamSlot = slot >= 0 ? slot : team.length - 1;
          const original = team[teamSlot];
          const usedItems = new Set(team.filter((_, i) => i !== teamSlot).map(pokemon => toID(pokemon.item)));
          const availableItems = itemPool.filter(item => !usedItems.has(toID(item)));
          const item = candidate.item || availableItems[Math.floor(random.random() * availableItems.length)];
          if (item && !usedItems.has(toID(item))) for (let setAttempt = 0; setAttempt < 16; setAttempt++) {
            const selected = [...moves];
            for (let i = 0; i < 4; i++) {
              const j = i + Math.floor(random.random() * (selected.length - i));
              [selected[i], selected[j]] = [selected[j], selected[i]];
            }
            const abilities = Object.values(species.abilities);
            team[teamSlot] = {
              name: species.name, species: species.name,
              item,
              ability: abilities[Math.floor(random.random() * abilities.length)], moves: selected.slice(0, 4),
              nature: 'Serious', gender: species.gender ?? '', level: 50,
              evs: {hp: 11, atk: 11, def: 11, spa: 11, spd: 11, spe: 11},
              ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31},
            };
            if (!validator.validateTeam(team)) return packValidatedTeam(team);
            team[teamSlot] = original;
          }
        }
      }
    }
    return packValidatedTeam(team);
  }
  throw new Error(`Could not generate a legal Champions team after 100 deterministic seeds from ${seed.join(',')}`);
}

type Tensor = number[] | number[][];
export interface Checkpoint {
  schema: number; format: string; engineVersion: string; switchExploration?: number; modelArchitecture?: string; transformerLayers?: number; transformerHeads?: number; stateDim: number; actionDim: number;
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
function sigmoid(value: number) { return 1 / (1 + Math.exp(-value)); }
function gruCell(input: number[], hidden: number[], weights: Record<string, Tensor>) {
  const inputWeights = weights['memory.weight_ih'] as number[][];
  const hiddenWeights = weights['memory.weight_hh'] as number[][];
  const inputBias = weights['memory.bias_ih'] as number[];
  const hiddenBias = weights['memory.bias_hh'] as number[];
  const size = hidden.length;
  const inputGates = dense(input, inputWeights, inputBias);
  const hiddenGates = dense(hidden, hiddenWeights, hiddenBias);
  return hidden.map((previous, i) => {
    const reset = sigmoid(inputGates[i] + hiddenGates[i]);
    const update = sigmoid(inputGates[size + i] + hiddenGates[size + i]);
    const candidate = Math.tanh(inputGates[2 * size + i] + reset * hiddenGates[2 * size + i]);
    return (1 - update) * candidate + update * previous;
  });
}
export class Policy {
  private readonly candidateConditioned: boolean;
  private readonly boundedValue: boolean;
  private readonly recurrent: boolean;
  private readonly hiddenSize: number;
  private readonly deepState: boolean;
  private readonly transformer: boolean;
  private readonly transformerLayers: number;
  constructor(readonly checkpoint: Checkpoint) {
    if (checkpoint.schema !== 1 || checkpoint.format !== CHAMPIONS_FORMAT || checkpoint.engineVersion !== CHAMPIONS_ENGINE_VERSION || checkpoint.stateDim !== STATE_DIM || checkpoint.actionDim !== ACTION_DIM) throw new Error('Incompatible Champions checkpoint');
    const gruNames = ['candidate-conditioned-gru-v1', 'candidate-conditioned-gru-v2', 'candidate-conditioned-gru-v3-transformer'];
    const ffNames = ['candidate-conditioned-v2', 'candidate-conditioned-v3', 'candidate-conditioned-v4', 'candidate-conditioned-v5-transformer'];
    this.recurrent = gruNames.includes(checkpoint.modelArchitecture ?? '');
    this.candidateConditioned = ffNames.includes(checkpoint.modelArchitecture ?? '') || this.recurrent;
    this.boundedValue = ffNames.filter(name => name !== 'candidate-conditioned-v2').includes(checkpoint.modelArchitecture ?? '') || this.recurrent;
    if (checkpoint.modelArchitecture !== undefined && ![...gruNames, ...ffNames].includes(checkpoint.modelArchitecture)) throw new Error(`Unsupported Champions policy architecture: ${checkpoint.modelArchitecture}`);
    this.transformer = ['candidate-conditioned-v5-transformer', 'candidate-conditioned-gru-v3-transformer'].includes(checkpoint.modelArchitecture ?? '');
    this.transformerLayers = Number(checkpoint.transformerLayers ?? 2);
    // Hidden width and depth come from the tensors themselves (64 / 1 for every earlier checkpoint).
    const stateRows = (checkpoint.weights[this.transformer ? 'encoder.pool.weight' : 'state.weight'] as number[][] | undefined);
    this.hiddenSize = Array.isArray(stateRows) && stateRows.length ? stateRows.length : 64;
    this.deepState = checkpoint.weights['state2.weight'] !== undefined;
    const dims: Record<string, [number, number?]> = this.candidateConditioned
      ? {'state.weight':[this.hiddenSize,STATE_DIM], 'state.bias':[this.hiddenSize], 'action.weight':[this.hiddenSize,ACTION_DIM], 'action.bias':[this.hiddenSize], 'score.weight':[1,this.hiddenSize], 'score.bias':[1], 'critic.weight':[1,this.hiddenSize], 'critic.bias':[1]}
      : {'state.weight':[64,STATE_DIM], 'state.bias':[64], 'action.weight':[ACTION_DIM,64], 'action.bias':[ACTION_DIM], 'critic.weight':[1,64], 'critic.bias':[1]};
    if (this.transformer) {
      delete dims['state.weight']; delete dims['state.bias'];
      const H = this.hiddenSize, ln = (name: string): [number] => [64], lin = (out: number, inn: number): [number, number] => [out, inn];
      Object.assign(dims, {'encoder.tok_global.weight': lin(64, 32), 'encoder.tok_global.bias': [64], 'encoder.tok_mon.weight': lin(64, 64), 'encoder.tok_mon.bias': [64], 'encoder.pos': lin(13, 64), 'encoder.pool.weight': lin(H, 128), 'encoder.pool.bias': [H]});
      for (let l = 0; l < this.transformerLayers; l++) Object.assign(dims, {
        [`encoder.enc${l}.ln1.weight`]: ln('a'), [`encoder.enc${l}.ln1.bias`]: [64], [`encoder.enc${l}.qkv.weight`]: lin(192, 64), [`encoder.enc${l}.qkv.bias`]: [192],
        [`encoder.enc${l}.proj.weight`]: lin(64, 64), [`encoder.enc${l}.proj.bias`]: [64], [`encoder.enc${l}.ln2.weight`]: [64], [`encoder.enc${l}.ln2.bias`]: [64],
        [`encoder.enc${l}.ff1.weight`]: lin(128, 64), [`encoder.enc${l}.ff1.bias`]: [128], [`encoder.enc${l}.ff2.weight`]: lin(64, 128), [`encoder.enc${l}.ff2.bias`]: [64]});
    }
    if (this.recurrent) Object.assign(dims, {'memory.weight_ih':[3*this.hiddenSize,this.hiddenSize], 'memory.weight_hh':[3*this.hiddenSize,this.hiddenSize], 'memory.bias_ih':[3*this.hiddenSize], 'memory.bias_hh':[3*this.hiddenSize]});
    if (this.deepState) Object.assign(dims, {'state2.weight':[this.hiddenSize,this.hiddenSize], 'state2.bias':[this.hiddenSize]});
    for (const [name, [rows, cols]] of Object.entries(dims)) {
      const data = checkpoint.weights[name];
      if (!Array.isArray(data) || data.length !== rows || (cols && data.some(row => !Array.isArray(row) || row.length !== cols)) || data.flat().some(x => typeof x !== 'number' || !Number.isFinite(x))) throw new Error(`Invalid checkpoint tensor ${name}`);
    }
  }
  /** Entity transformer: 1 global + 12 Pokémon tokens, pre-LN blocks, ReLU FFN; mirrors agents/train_champions.py exactly. */
  private encodeEntities(state: number[]): number[] {
    const w = this.checkpoint.weights, D = 64, HEADS = 4, DH = D / HEADS;
    const lin = (x: number[], name: string) => dense(x, w[`${name}.weight`] as number[][], w[`${name}.bias`] as number[]);
    const norm = (x: number[], name: string) => {
      const mean = x.reduce((a, b) => a + b, 0) / x.length, variance = x.reduce((n, a) => n + (a - mean) ** 2, 0) / x.length, inverse = 1 / Math.sqrt(variance + 1e-5);
      const scale = w[`${name}.weight`] as number[], shift = w[`${name}.bias`] as number[];
      return x.map((a, i) => (a - mean) * inverse * scale[i] + shift[i]);
    };
    const pos = w['encoder.pos'] as number[][];
    let tokens: number[][] = [lin(state.slice(0, 32), 'encoder.tok_global').map((a, i) => a + pos[0][i])];
    for (let i = 0; i < 12; i++) tokens.push(lin(state.slice(32 + 64 * i, 32 + 64 * (i + 1)), 'encoder.tok_mon').map((a, j) => a + pos[1 + i][j]));
    for (let layer = 0; layer < this.transformerLayers; layer++) {
      const qkv = tokens.map(token => lin(norm(token, `encoder.enc${layer}.ln1`), `encoder.enc${layer}.qkv`));
      const attended = tokens.map((_, i) => {
        const out = new Array<number>(D).fill(0);
        for (let head = 0; head < HEADS; head++) {
          const lo = head * DH;
          const scores = tokens.map((__, j) => { let dot = 0; for (let d = 0; d < DH; d++) dot += qkv[i][lo + d] * qkv[j][D + lo + d]; return dot / Math.sqrt(DH); });
          const top = Math.max(...scores), exps = scores.map(x => Math.exp(x - top)), total = exps.reduce((a, b) => a + b, 0);
          for (let j = 0; j < tokens.length; j++) for (let d = 0; d < DH; d++) out[lo + d] += (exps[j] / total) * qkv[j][2 * D + lo + d];
        }
        return out;
      });
      tokens = tokens.map((token, i) => {
        const projected = lin(attended[i], `encoder.enc${layer}.proj`), mixed = token.map((a, j) => a + projected[j]);
        const hidden = lin(norm(mixed, `encoder.enc${layer}.ln2`), `encoder.enc${layer}.ff1`).map(a => Math.max(0, a)), ff = lin(hidden, `encoder.enc${layer}.ff2`);
        return mixed.map((a, j) => a + ff[j]);
      });
    }
    const mean = new Array<number>(D).fill(0);
    for (let i = 1; i < tokens.length; i++) for (let d = 0; d < D; d++) mean[d] += tokens[i][d] / (tokens.length - 1);
    return dense([...tokens[0], ...mean], w['encoder.pool.weight'] as number[][], w['encoder.pool.bias'] as number[], true);
  }
  predict(encoded: Encoded, simpleScoreWeight?: number, priorHidden?: number[]) {
    const w = this.checkpoint.weights;
    const scoreWeight = simpleScoreWeight ?? this.checkpoint.simpleScoreWeight ?? 0;
    let stateHidden = this.transformer ? this.encodeEntities(encoded.state) : dense(encoded.state, w['state.weight'] as number[][], w['state.bias'] as number[], true);
    if (this.deepState) stateHidden = dense(stateHidden, w['state2.weight'] as number[][], w['state2.bias'] as number[], true);
    const hidden = this.recurrent ? gruCell(stateHidden, priorHidden ?? new Array(this.hiddenSize).fill(0), w) : stateHidden;
    const logits = this.candidateConditioned
      ? encoded.candidates.map(candidate => {
        const actionHidden = (w['action.weight'] as number[][]).map((row, i) =>
          Math.tanh(hidden[i] + (w['action.bias'] as number[])[i] + candidate.features.reduce((n, x, j) => n + x * row[j], 0)));
        return (w['score.weight'] as number[][])[0].reduce((n, x, i) => n + x * actionHidden[i], (w['score.bias'] as number[])[0]) + scoreWeight * candidate.simpleScore;
      })
      : encoded.candidates.map(candidate => {
        const context = dense(hidden, w['action.weight'] as number[][], w['action.bias'] as number[]);
        return candidate.features.reduce((n, x, i) => n + x * context[i], 0) + scoreWeight * candidate.simpleScore;
      });
    if (logits.some(value => !Number.isFinite(value))) throw new Error('Nonfinite Champions policy logit');
    const max = Math.max(...logits), exps = logits.map(x => Math.exp(x - max)), sum = exps.reduce((a,b) => a+b, 0);
    if (!Number.isFinite(sum) || sum <= 0) throw new Error('Invalid Champions policy probability normalization');
    const probabilities = exps.map(x => x / sum);
    const entropy = -probabilities.reduce((n, p) => n + (p > 0 ? p * Math.log(p) : 0), 0);
    const rawValue = dense(hidden, w['critic.weight'] as number[][], w['critic.bias'] as number[])[0];
    return {probabilities, value: this.boundedValue ? Math.tanh(rawValue) : rawValue, entropy, hidden};
  }
  /** temperature 1 (default) samples the trained distribution; <1 sharpens it and 0 plays the argmax. Used only at play time, never in training. */
  /**
   * Training-time exploration: mixes `exploration` of the probability mass uniformly over candidates that contain a voluntary switch.
   * The mixture is the behaviour policy (its exact log-probability is what PPO sees); deployment uses exploration = 0.
   * Candidate features 1 and 25 are the "switch" flags of the two slot components; forced switches make every candidate a switch.
   */
  static mixSwitchExploration(encoded: Encoded, probabilities: number[], exploration: number) {
    if (!(exploration > 0)) return probabilities;
    const mask = encoded.candidates.map(candidate => Number(candidate.features[1] > 0.5 || candidate.features[25] > 0.5));
    const total = mask.reduce((a, b) => a + b, 0);
    return total > 0 ? probabilities.map((p, i) => (1 - exploration) * p + exploration * mask[i] / total) : probabilities;
  }
  choose(encoded: Encoded, random: () => number, simpleScoreWeight?: number, priorHidden?: number[], temperature = 1, exploration = 0) {
    const prediction = this.predict(encoded, simpleScoreWeight, priorHidden);
    const behaviour = Policy.mixSwitchExploration(encoded, prediction.probabilities, exploration);
    let sampling = behaviour;
    if (temperature !== 1) {
      if (temperature <= 0) { const best = sampling.indexOf(Math.max(...sampling)); sampling = sampling.map((_, i) => Number(i === best)); }
      else { const sharpened = sampling.map(p => Math.pow(p, 1 / temperature)); const total = sharpened.reduce((a, b) => a + b, 0); sampling = sharpened.map(p => p / total); }
    }
    let threshold = random(), action = encoded.candidates.length - 1;
    for (let i = 0; i < sampling.length; i++) {
      threshold -= sampling[i];
      if (threshold < 0) { action = i; break; }
    }
    return {action, logp: Math.log(Math.max(1e-30, behaviour[action])), value: prediction.value, entropy: prediction.entropy, nextHidden:prediction.hidden};
  }
}

interface Step {state: number[]; actions: number[][]; simpleScores: number[]; action: number; logp: number; value: number; entropy: number; potential: number}
interface Episode {steps: Step[]; reward: number; side: SideId}
interface RejectionDiagnostic {
  seed: number; side: SideId; request: any; candidates: Candidate[];
  selectedAction: {index: number; choice: string; logp: number; value: number; entropy: number};
  rejection: string; kind: 'hidden-trap-reveal'|'illegal-action';
}
interface GameResult {winner: SideId | null; turns: number; truncated: boolean; retries: number; hiddenTrapReveals: number; illegalActionRetries: number; rejectionDiagnostics: RejectionDiagnostic[]; episodes: Episode[]}
function prng(seed: number) {
  const rng = new showdown.PRNG(`41,53,${(seed >>> 16) & 65535},${seed & 65535}`);
  return () => rng.random();
}

export interface Choice {action: number; logp: number; value: number; choice: string; entropy?: number; nextHidden?: number[]}
export async function play(seed: number, choose: (side: SideId, encoded: Encoded, hidden?: number[], request?: any) => Choice, maxTurns = 200, trace = false, fixedTeams: Partial<Record<SideId, string>> = {}): Promise<GameResult> {
  const stream = new BattleStream();
  const streams = getPlayerStreams(stream);
  const lo = seed & 65535, hi = (seed >>> 16) & 65535;
  const teams = [fixedTeams.p1 ?? makeTeam([71,89,hi,lo]), fixedTeams.p2 ?? makeTeam([72,89,hi,lo])];
  const trajectories: Record<SideId, Step[]> = {p1: [], p2: []};
  const views: Record<SideId, VisibleState> = {p1: new VisibleState(), p2: new VisibleState()};
  const requestKeys: Record<SideId, string> = {p1: '', p2: ''};
  const rejectedParts: Record<SideId, Set<string>> = {p1: new Set(), p2: new Set()};
  const memories: Partial<Record<SideId, number[]>> = {};
  const lastChoices: Partial<Record<SideId, {choice:string; requestKey:string; request:any; candidates:Candidate[]; action:number; logp:number; value:number; entropy:number; memoryBefore?:number[]}>> = {};
  const rejectionDiagnostics: RejectionDiagnostic[] = [];
  let winner: SideId | null = null, turns = 0, ended = false, truncated = false, retries = 0, hiddenTrapReveals = 0, illegalActionRetries = 0;
  const traceCount: Record<SideId, number> = {p1: 0, p2: 0};
  let finishDecisions!: () => void;
  const terminal = new Promise<void>(resolve => {finishDecisions = resolve;});
  const jobs: Promise<unknown>[] = (['p1','p2'] as SideId[]).map(async side => {
    for await (const chunk of streams[side]) for (const line of chunk.split('\n')) {
      if (line.startsWith('|error|')) {
        const last = lastChoices[side];
        if (!line.includes('[Unavailable choice]') && !line.includes('[Invalid choice]')) throw new Error(`Simulator error for ${side}: ${line}`);
        if (!last) throw new Error(`Choice error without a recorded decision for ${side}: ${line}`);
        const hiddenTrapReveal = line.includes('[Unavailable choice]') && last.choice.includes('switch ') &&
          last.request.active?.some((slot:any) => slot?.maybeTrapped === true);
        const diagnostic: RejectionDiagnostic = {seed, side, request:last.request, candidates:last.candidates,
          selectedAction:{index:last.action,choice:last.choice,logp:last.logp,value:last.value,entropy:last.entropy},
          rejection:line, kind:hiddenTrapReveal ? 'hidden-trap-reveal' : 'illegal-action'};
        rejectionDiagnostics.push(diagnostic);
        console.error(JSON.stringify({trace:'rejected-choice-details',...diagnostic}));
        if (line.includes('[Invalid choice]')) {
          throw new Error(`Generated an invalid Champions choice; preserving the failed battle in the ledger: ${line}`);
        }
        retries++;
        if (hiddenTrapReveal) hiddenTrapReveals++;
        else illegalActionRetries++;
        trajectories[side].pop();
        memories[side] = last.memoryBefore;
        if (last.requestKey === requestKeys[side]) {
          for (const part of last.choice.split(',').map(value => value.trim())) rejectedParts[side].add(part);
        }
        lastChoices[side] = undefined;
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
        const encodeStart = performance.now();
        const encoded = encode(request, views[side], side);
        profile.encodeMs += performance.now() - encodeStart; profile.encodeCalls++;
        if (rejectedParts[side].size) {
          encoded.candidates = encoded.candidates.filter(candidate => !candidate.choice.split(',').some(part => rejectedParts[side].has(part.trim())));
          if (!encoded.candidates.length) throw new Error(`All encoded choices were rejected for ${side}: ${[...rejectedParts[side]].join('; ')}`);
        }
        const memoryBefore = memories[side];
        const chooseStart = performance.now();
        const result = choose(side, encoded, memoryBefore, request);
        profile.chooseMs += performance.now() - chooseStart; profile.chooseCalls++;
        if (result.nextHidden) memories[side] = result.nextHidden;
        lastChoices[side] = {choice:result.choice, requestKey, request, candidates:encoded.candidates,
          action:result.action, logp:result.logp, value:result.value, entropy:result.entropy ?? 0, memoryBefore};
        if (trace && traceCount[side]++ < 40) console.error(JSON.stringify({trace:'choice',seed,side,turn:views[side].turn,teamPreview:!!request.teamPreview,candidates:encoded.candidates.length,action:result.action,logp:result.logp,choice:result.choice}));
      trajectories[side].push({state: encoded.state, actions: encoded.candidates.map(c => c.features),
        simpleScores: encoded.candidates.map(c => c.simpleScore), action: result.action, logp: result.logp,
        value: result.value, entropy: result.entropy ?? 0, potential: potential(request, views[side], side)});
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
    return {winner, turns, truncated, retries, hiddenTrapReveals, illegalActionRetries, rejectionDiagnostics, episodes};
  } finally {
    if (timer) clearTimeout(timer);
    finishDecisions();
    await stream.writeEnd();
    for (const job of jobs) void job.catch(() => {});
  }
}

type OpponentType = 'selfplay'|'heuristic'|'heuristic2'|'human'|'random'|'pool';
const GUARD_MOVES = new Set(['protect', 'detect', 'kingsshield', 'spikyshield', 'banefulbunker', 'obstruct', 'silktrap', 'burningbulwark']);
const hpOf = (condition: string | undefined) => { const m = /^(\d+)\/(\d+)/.exec(String(condition ?? '')); return m ? Number(m[1]) / Number(m[2]) : 1; };
/**
 * Scripted "guarded" opponent: the fixed damage heuristic plus human-like tendencies as score bonuses - Protect (more when hurt),
 * Fake Out on the first turn, and switching only when badly hurt. Used only as a training opponent so learners must handle
 * these behaviours; nothing here is part of any learned policy.
 */
export interface GuardTuning {protectHurt: number; protectHealthy: number; fakeOut: number; switchHurt: number; switchOther: number; noise: number}
export const DEFAULT_GUARD: GuardTuning = (() => {
  // Calibrated on our own ladder games: 0.50 voluntary switches per game per side (humans 0.48), 12.8% Protect share of moves (humans 11.8%).
  const base = {protectHurt: 0.95, protectHealthy: 0.55, fakeOut: 0.6, switchHurt: 1.5, switchOther: 0.5, noise: 0.05};
  try { return {...base, ...JSON.parse(process.env.GUARD_TUNING ?? '{}')}; } catch { return base; }
})();
export function guardedAction(encoded: Encoded, request: any, random: () => number, tuning: GuardTuning = DEFAULT_GUARD): number {
  const turn = Math.round((encoded.state[0] ?? 0) * 100);
  let best = 0, bestScore = -Infinity;
  encoded.candidates.forEach((candidate, index) => {
    let score = candidate.simpleScore + tuning.noise * random();
    candidate.choice.split(',').map(part => part.trim()).forEach((part, slot) => {
      const tokens = part.split(/\s+/), hp = hpOf(request?.side?.pokemon?.[slot]?.condition);
      if (tokens[0] === 'move') {
        const id = request?.active?.[slot]?.moves?.[Number(tokens[1]) - 1]?.id;
        if (GUARD_MOVES.has(id)) score += hp < 0.5 ? tuning.protectHurt : tuning.protectHealthy;
        if (id === 'fakeout' && turn <= 1) score += tuning.fakeOut;
      } else if (tokens[0] === 'switch') score += hp < 0.35 ? tuning.switchHurt : tuning.switchOther;
    });
    if (score > bestScore) { bestScore = score; best = index; }
  });
  return best;
}
/**
 * Empirical-human opponent: per active slot, sample Protect / Fake Out / voluntary switch / attack with the conditional rates measured
 * from our own ladder logs (scripts/human-behaviour.py -> human-behaviour.json, keyed "turnBucket:hpBucket"), then take the highest-scoring
 * candidate that realises the sampled kinds. Humans switched about 4-10% per slot-turn almost independently of HP.
 */
type Rates = {protect: number; fakeout: number; switch: number};
interface HumanBand {rows: number; focusFire: number; table: Record<string, Rates>}
const HUMAN_DATA: {table: Record<string, Rates>; bands: Record<string, HumanBand>} = (() => {
  try { return JSON.parse(readFileSync(new URL('../../runs/champions-vgc-2026-reg-mc/human-behaviour.json', import.meta.url), 'utf8')); } catch { return {table: {}, bands: {}}; }
})();
/** Per-battle human style: a rating band (drawn by observed frequency), jittered rates, and a focus-fire preference. Cached per RNG (one per battle side). */
interface HumanStyle {table: Record<string, Rates>; focus: number; sloppy: number}
const styleCache = new WeakMap<object, HumanStyle>();
function humanStyle(random: () => number): HumanStyle {
  let style = styleCache.get(random);
  if (style) return style;
  const bands = Object.values(HUMAN_DATA.bands);
  let table = HUMAN_DATA.table, focus = 0.3;
  if (bands.length) {
    let draw = random() * bands.reduce((n, band) => n + band.rows, 0), band = bands[0];
    for (const candidate of bands) { draw -= candidate.rows; if (draw <= 0) { band = candidate; break; } }
    table = band.table; focus = band.focusFire;
  }
  const jitter = 0.7 + 0.6 * random();                     // this player is somewhat more or less Protect/switch-happy than the band average
  const scaled: Record<string, Rates> = {};
  for (const [key, r] of Object.entries(table)) scaled[key] = {protect: r.protect * jitter, fakeout: r.fakeout, switch: r.switch * (2 - jitter)};
  style = {table: scaled, focus: Math.max(0, Math.min(1, focus + 0.2 * (random() - 0.5))), sloppy: 0.02 + 0.13 * random()};
  styleCache.set(random, style);
  return style;
}
/**
 * Empirical-human opponent (scripts/human-behaviour.py -> human-behaviour.json). Each battle gets a style (rating band, rate jitter,
 * focus-fire preference, occasional sloppy pick). Per active slot it samples Protect / Fake Out / voluntary switch / attack with the measured
 * conditional rates ("turnBucket:hpBucket"), then takes the highest-scoring candidate realising the sampled kinds and the target preference.
 */
export function humanAction(encoded: Encoded, request: any, random: () => number): number {
  const style = humanStyle(random);
  const turn = Math.round((encoded.state[0] ?? 0) * 100);
  const turnBucket = turn <= 1 ? 0 : turn <= 3 ? 1 : 2;
  const slots = Math.max(1, request?.active?.length ?? 2);
  if (random() < style.sloppy) return Math.floor(random() * encoded.candidates.length);
  const wanted: string[] = [];
  for (let slot = 0; slot < slots; slot++) {
    const hp = hpOf(request?.side?.pokemon?.[slot]?.condition), rates = style.table[`${turnBucket}:${hp < 0.35 ? 0 : hp < 0.7 ? 1 : 2}`];
    const u = random();
    wanted.push(!rates ? 'move' : u < rates.protect ? 'protect' : u < rates.protect + rates.fakeout ? 'fakeout' : u < rates.protect + rates.fakeout + rates.switch ? 'switch' : 'move');
  }
  const focusWanted = random() < style.focus;
  let best = 0, bestScore = -Infinity;
  encoded.candidates.forEach((candidate, index) => {
    let score = candidate.simpleScore + 0.05 * random();
    const parts = candidate.choice.split(',').map(part => part.trim());
    const targets: string[] = [];
    parts.forEach((part, slot) => {
      const tokens = part.split(/\s+/), id = tokens[0] === 'move' ? request?.active?.[slot]?.moves?.[Number(tokens[1]) - 1]?.id : undefined;
      const kind = tokens[0] === 'switch' ? 'switch' : GUARD_MOVES.has(id) ? 'protect' : id === 'fakeout' ? 'fakeout' : 'move';
      if (kind === wanted[slot]) score += 10;      // realise the sampled kind; within it the damage heuristic decides
      if (kind === 'move' && Number(tokens[2]) > 0) targets.push(tokens[2]);   // 1/2 = the two foes
    });
    if (targets.length === 2) score += (targets[0] === targets[1]) === focusWanted ? 1.5 : 0;
    if (score > bestScore) { bestScore = score; best = index; }
  });
  return best;
}
/** One training battle. RNGs derive from the batch seed and the attempt index, so the result is independent of scheduling. */
export interface TeamSets {learner?: string[]; opponent?: string[]; poolTeams?: Record<string, string>; opponentShare?: number}
const teamHash = (n: number) => Math.imul(n | 0, 2654435761) >>> 0;
/** Deterministic team assignment from (seed, index): learner-side teams from `learner`, half the opponents from `opponent`. */
function assignTeams(teams: TeamSets | undefined, seed: number, learnerSide: SideId, selfplay: boolean, poolName?: string): Partial<Record<SideId, string>> {
  if (!teams?.learner?.length) return {};
  const pick = (list: string[], salt: number) => list[teamHash(seed * 31 + salt) % list.length];
  if (selfplay) return {p1: pick(teams.learner, 1), p2: pick(teams.learner, 2)};
  const other: SideId = learnerSide === 'p1' ? 'p2' : 'p1';
  const fixed: Partial<Record<SideId, string>> = {[learnerSide]: pick(teams.learner, 3)};
  // A pool policy plays its own native team when it has one; otherwise half the opponents draw from the shared opponent teams.
  if (poolName && teams.poolTeams?.[poolName]) fixed[other] = teams.poolTeams[poolName];
  else if (teams.opponent?.length && (teamHash(seed * 17 + 5) % 1000) / 1000 < (teams.opponentShare ?? 0.5)) fixed[other] = pick(teams.opponent, 4);
  return fixed;
}
async function runBattle(model: Policy, baseSeed: number, i: number, opponentType: OpponentType, maxTurns?: number, debug?: boolean, poolPolicy?: Policy, teams?: TeamSets, poolName?: string) {
  if (opponentType === 'pool' && !poolPolicy) throw new Error('A pool battle needs an opponent policy');
  const rngs: Record<SideId, () => number> = {p1: prng(baseSeed + i * 2), p2: prng(baseSeed + i * 2 + 1)};
  const learnerSide: SideId = opponentType === 'selfplay' ? 'p1' : ((baseSeed + i) % 2 ? 'p1' : 'p2');
  const result = await play(baseSeed + i, (side, encoded, hidden, request) => {
    let prediction: {action:number;logp:number;value:number;entropy?:number;nextHidden?:number[]};
    if (opponentType === 'selfplay' || side === learnerSide) prediction = model.choose(encoded, rngs[side], undefined, hidden, 1, Number(model.checkpoint.switchExploration ?? 0));
    else if (opponentType === 'pool') prediction = poolPolicy!.choose(encoded, rngs[side], undefined, hidden);
    else if (opponentType === 'heuristic') prediction = {action:heuristic(encoded),logp:0,value:0};
    else if (opponentType === 'heuristic2') prediction = {action:guardedAction(encoded, request, rngs[side]),logp:0,value:0};
    else if (opponentType === 'human') prediction = {action:humanAction(encoded, request, rngs[side]),logp:0,value:0};
    else prediction = {action:Math.floor(rngs[side]() * encoded.candidates.length),logp:0,value:0};
    const candidate = encoded.candidates[prediction.action];
    return {...prediction, choice: candidate.choice};
  }, maxTurns, debug, assignTeams(teams, baseSeed + i, learnerSide, opponentType === 'selfplay', poolName));
  return {result, learnerSide, episodes: result.episodes.filter(episode => opponentType === 'selfplay' || episode.side === learnerSide)};
}

export async function collect(model: Policy, args: {games: number; seed: number; opponent?: OpponentType; maxTurns?: number; debug?: boolean; onBattleStart?: (seed: number, opponent: string) => void; onBattleEnd?: (seed: number, opponent: string, completed: boolean, truncated: boolean) => void}) {
  if (!Number.isInteger(args.games) || args.games < 1 || !Number.isInteger(args.seed) || args.seed < 0) throw new Error('Invalid self-play batch size or seed');
  const opponentType = args.opponent ?? 'selfplay';
  const episodes: Episode[] = [];
  const rejectionDiagnostics: RejectionDiagnostic[] = [];
  let completed = 0, attempts = 0, truncated = 0, retries = 0, hiddenTrapReveals = 0, illegalActionRetries = 0;
  for (let i = 0; completed < args.games; i++) {
    attempts++;
    args.onBattleStart?.(args.seed + i, opponentType);
    const {result, episodes: kept} = await runBattle(model, args.seed, i, opponentType, args.maxTurns, args.debug);
    retries += result.retries;
    hiddenTrapReveals += result.hiddenTrapReveals;
    illegalActionRetries += result.illegalActionRetries;
    rejectionDiagnostics.push(...result.rejectionDiagnostics);
    if (result.truncated) {
      truncated++;
      args.onBattleEnd?.(args.seed + i, opponentType, false, true);
      if (args.debug || truncated >= 3) break;
      continue;
    }
    if (result.episodes.some(episode => !episode.steps.length)) throw new Error(`Empty self-play trajectory in battle ${args.seed+i}`);
    completed++;
    episodes.push(...kept);
    args.onBattleEnd?.(args.seed + i, opponentType, true, false);
  }
  return {episodes, attempts, completed, truncated, retries, hiddenTrapReveals, illegalActionRetries,
    rejectionDiagnostics, turnsRemaining: args.games - completed};
}

/**
 * Plays an explicit list of attempt indices with up to `concurrency` battles in flight.
 * Per-index results are returned so the learner can reassemble them in index order, making
 * the merged batch identical to sequential `collect` regardless of worker or concurrency choice.
 */
export async function collectSlice(model: Policy, args: {indices: number[]; seed: number; opponent?: OpponentType; maxTurns?: number; concurrency?: number;
  kinds?: string[]; pool?: Record<string, Policy>; teams?: TeamSets}) {
  if (!Array.isArray(args.indices) || !Number.isInteger(args.seed) || args.seed < 0 ||
      args.indices.some(i => !Number.isInteger(i) || i < 0)) throw new Error('Invalid collectSlice request');
  const opponentType = args.opponent ?? 'selfplay';
  const concurrency = Math.max(1, Math.floor(args.concurrency ?? 1));
  const results: {index: number; kind: string; truncated: boolean; retries: number; hiddenTrapReveals: number; illegalActionRetries: number;
    rejectionDiagnostics: RejectionDiagnostic[]; episodes: Episode[]}[] = [];
  let cursor = 0;
  const runner = async () => {
    while (cursor < args.indices.length) {
      const slot = cursor++;
      const index = args.indices[slot];
      // A per-attempt kind ("selfplay", "heuristic", "random" or "pool:<name>") lets one batch mix opponents deterministically.
      const kind = args.kinds?.[slot] ?? opponentType;
      const [type, poolName] = kind.split(':') as [OpponentType, string?];
      if (type === 'pool' && !(poolName && args.pool?.[poolName])) throw new Error(`Unknown pool opponent ${kind}`);
      const {result, episodes} = await runBattle(model, args.seed, index, type, args.maxTurns, false, poolName ? args.pool![poolName] : undefined, args.teams, poolName);
      if (!result.truncated && result.episodes.some(episode => !episode.steps.length)) throw new Error(`Empty self-play trajectory in battle ${args.seed+index}`);
      results.push({index, kind, truncated: result.truncated, retries: result.retries, hiddenTrapReveals: result.hiddenTrapReveals,
        illegalActionRetries: result.illegalActionRetries, rejectionDiagnostics: result.rejectionDiagnostics,
        episodes: result.truncated ? [] : episodes});
    }
  };
  await Promise.all(Array.from({length: Math.min(concurrency, args.indices.length)}, runner));
  results.sort((a, b) => a.index - b.index);
  return results;
}

async function main() {
  let cached: {version: unknown; policy: Policy} | undefined;
  let poolCache: {key: unknown; policies: Record<string, Policy>} | undefined;
  let teamsCache: {key: unknown; teams: TeamSets} | undefined;
  for await (const raw of createInterface({input: process.stdin, crlfDelay: Infinity})) {
    const message = JSON.parse(raw);
    // A repeated policyVersion (with `model` omitted) reuses the validated policy; a new version must carry its weights.
    if (message.weightsB64) {
      // Exact float32 tensors from the learner; widening to double reproduces the JSON-number path bit for bit.
      message.model.weights = Object.fromEntries(Object.entries(message.weightsB64 as Record<string, {shape: number[]; data: string}>).map(([name, {shape, data}]) => {
        const bytes = Buffer.from(data, 'base64');
        const flat = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        const tensor = shape.length === 1 ? Array.from(flat) : Array.from({length: shape[0]}, (_, row) => Array.from(flat.subarray(row * shape[1], (row + 1) * shape[1])));
        return [name, tensor];
      }));
    }
    if (message.teams && message.teamsKey) teamsCache = {key: message.teamsKey, teams: message.teams};
    if (message.teamsKey && teamsCache?.key === message.teamsKey) message.teams = teamsCache!.teams;
    if (message.poolB64) {
      const decode = (payload: Record<string, {shape: number[]; data: string}>) => Object.fromEntries(Object.entries(payload).map(([name, {shape, data}]) => {
        const bytes = Buffer.from(data, 'base64');
        const flat = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        return [name, shape.length === 1 ? Array.from(flat) : Array.from({length: shape[0]}, (_, row) => Array.from(flat.subarray(row * shape[1], (row + 1) * shape[1])))];
      }));
      poolCache = {key: message.poolKey, policies: Object.fromEntries(Object.entries(message.poolB64 as Record<string, {meta: Checkpoint; weightsB64: any}>)
        .map(([name, {meta, weightsB64}]) => [name, new Policy({...meta, weights: decode(weightsB64)})]))};
    }
    let model: Policy;
    if (message.model === undefined && cached && message.policyVersion !== undefined && cached.version === message.policyVersion) model = cached.policy;
    else {
      const parseStart = performance.now();
      model = new Policy(message.model as Checkpoint);
      profile.policyParseMs += performance.now() - parseStart; profile.policyParseCalls++;
      cached = message.policyVersion === undefined ? undefined : {version: message.policyVersion, policy: model};
    }
    if (message.command === 'predict') {
      const fake = {state: message.encoded.state, candidates: message.encoded.actions.map((features: number[], index: number) => ({
        choice:'',features,simpleScore:message.encoded.simpleScores?.[index] ?? 0}))} as Encoded;
      const prediction = model.predict(fake, undefined, message.encoded.hidden);
      console.log(JSON.stringify({...prediction, mixedProbabilities: Policy.mixSwitchExploration(fake, prediction.probabilities, Number(message.encoded.exploration ?? 0))})); continue;
    }
    if (message.command === 'collectSlice') {
      const before = {...profile};
      const started = performance.now();
      if (message.kinds?.some((kind: string) => kind.startsWith('pool:')) && poolCache?.key !== message.poolKey) throw new Error('Opponent pool was not delivered to this worker');
      const results = await collectSlice(model, {...message, pool: poolCache?.policies});
      const wallMs = performance.now() - started;
      const delta = Object.fromEntries(Object.entries(profile).map(([key, value]) => [key, value - (before as Record<string, number>)[key]]));
      console.log(JSON.stringify({event: 'slice-finished', policyVersion: message.policyVersion, results, wallMs, profile: delta}));
      continue;
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
