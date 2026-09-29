import showdown from 'pokemon-showdown';
import type {
  Action, AgentDefinition, DecisionResponse, MatchRecord, MatchResult, Observation, RunMatchOptions, Side,
} from './contracts.js';
import { DEFAULT_LIMITS, FORMAT, PROTOCOL_VERSION } from './contracts.js';
import { AgentProcess } from './process.js';

const { BattleStream, getPlayerStreams, Teams, PRNG } = showdown;
const MAX_REASON = 300;

export function isAction(value: unknown): value is Action {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  const keys = Object.keys(action);
  if (action.type === 'move') return keys.every(key => key === 'type' || key === 'slot' || key === 'gimmick') &&
    Number.isInteger(action.slot) && (action.slot as number) > 0 &&
    (action.gimmick === undefined || action.gimmick === 'terastallize');
  return action.type === 'switch' && keys.every(key => key === 'type' || key === 'slot') &&
    Number.isInteger(action.slot) && (action.slot as number) > 0;
}

export function validateAction(action: unknown, legalActions: Action[]): action is Action {
  if (!isAction(action)) return false;
  return legalActions.some(candidate => candidate.type === action.type && candidate.slot === action.slot &&
    (candidate.type === 'move' ? candidate.gimmick === (action as Extract<Action, { type: 'move' }>).gimmick : true));
}

export function actionToChoice(action: Action): string {
  if (action.type === 'switch') return `switch ${action.slot}`;
  return `move ${action.slot}${action.gimmick === 'terastallize' ? ' terastallize' : ''}`;
}

export function legalActionsForRequest(request: Record<string, unknown>): Action[] {
  const side = isRecord(request.side) ? request.side : {};
  const pokemon = Array.isArray(side.pokemon) ? side.pokemon : [];
  if (Array.isArray(request.forceSwitch)) {
    const forced = request.forceSwitch.findIndex(Boolean);
    if (forced < 0) return [];
    const reviving = isRecord(pokemon[forced]) && pokemon[forced].reviving === true;
    return pokemon.flatMap((entry, index) => {
      if (index === forced || !isRecord(entry) || entry.active === true) return [];
      const fainted = typeof entry.condition === 'string' && /(?:^| )fnt(?:$| )/.test(entry.condition);
      return fainted === reviving ? [{ type: 'switch', slot: index + 1 } as Action] : [];
    });
  }
  if (request.teamPreview === true || request.wait === true || !Array.isArray(request.active)) return [];
  const active = isRecord(request.active[0]) ? request.active[0] : {};
  const actions: Action[] = [];
  const moves = Array.isArray(active.moves) ? active.moves : [];
  moves.forEach((move, index) => {
    if (!isRecord(move) || move.disabled === true) return;
    actions.push({ type: 'move', slot: index + 1 });
    if (active.canTerastallize) actions.push({ type: 'move', slot: index + 1, gimmick: 'terastallize' });
  });
  if (!actions.length) actions.push({ type: 'move', slot: 1 }); // simulator converts an empty move set to Struggle
  if (!active.trapped) {
    pokemon.forEach((entry, index) => {
      if (!isRecord(entry) || entry.active === true) return;
      if (typeof entry.condition === 'string' && /(?:^| )fnt(?:$| )/.test(entry.condition)) return;
      actions.push({ type: 'switch', slot: index + 1 });
    });
  }
  return actions;
}

class EventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private open = true;
  private producers = 0;

  constructor(producers: number) { this.producers = producers; }
  push(value: T) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }
  done() {
    if (--this.producers === 0) {
      this.open = false;
      while (this.waiters.length) this.waiters.shift()!({ value: undefined as T, done: true });
    }
  }
  async next(): Promise<IteratorResult<T>> {
    if (this.values.length) return { value: this.values.shift()!, done: false };
    if (!this.open) return { value: undefined as T, done: true };
    return new Promise(resolve => this.waiters.push(resolve));
  }
  [Symbol.asyncIterator]() { return this; }
}

type StreamEvent = { kind: 'public' | 'p1' | 'p2'; chunk: string };
type Runtime = {
  side: Side; process: AgentProcess; nextRequestId: number; totalUsedMs: number;
  pending?: { requestId: number; startedAt: number; action?: Action; retry?: boolean };
  events: string[];
};

export async function runMatch(options: RunMatchOptions): Promise<MatchResult> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  if (options.signal?.aborted) return { status: 'interrupted', winner: null, reason: 'cancelled', turn: 0, teams: [], inputLog: [] };
  const started = Date.now();
  const records = (record: MatchRecord) => options.onRecord(record);
  const inputLog: string[] = [];
  const stream = new BattleStream();
  const streams = getPlayerStreams(stream);
  const eventQueue = new EventQueue<StreamEvent>(3);
  let turn = 0;
  let finished = false;
  let result: MatchResult | null = null;
  let forfeitResult: { winner: Side; reason: string } | null = null;
  let streamFailure: string | null = null;
  let writeChain = Promise.resolve();
  const snapshotTeams = () => {
    const sides = stream.battle?.sides;
    if (!sides) return [];
    return sides.map(side => JSON.parse(JSON.stringify(side.team)));
  };
  const teams: unknown = [];

  const writeInput = (text: string) => {
    for (const line of text.split('\n')) {
      if (!line.startsWith('>')) continue;
      inputLog.push(line);
      records({ kind: 'input', turn, at: new Date().toISOString(), data: line });
    }
    writeChain = writeChain.then(() => streams.omniscient.write(text));
    return writeChain;
  };
  const diagnostic = (side: Side, message: string) => {
    records({ kind: 'diagnostic', side, turn, at: new Date().toISOString(), data: message.slice(0, MAX_REASON) });
  };

  const pumps = [
    [streams.spectator, 'public'], [streams.p1, 'p1'], [streams.p2, 'p2'],
  ] as const;
  for (const [source, kind] of pumps) {
    void (async () => {
      try { for await (const chunk of source) eventQueue.push({ kind, chunk }); }
      catch (error) { streamFailure = String(error); void stream.writeEnd(); }
      finally { eventQueue.done(); }
    })();
  }

  const runtimes: Record<Side, Runtime> = {
    p1: { side: 'p1', process: AgentProcess.start(options.p1, 'p1', message => diagnostic('p1', message)), nextRequestId: 1, totalUsedMs: 0, events: [] },
    p2: { side: 'p2', process: AgentProcess.start(options.p2, 'p2', message => diagnostic('p2', message)), nextRequestId: 1, totalUsedMs: 0, events: [] },
  };
  const playerNames: Record<Side, string> = { p1: `${options.p1.name} [p1]`, p2: `${options.p2.name} [p2]` };
  const stopProcesses = (reason: string) => {
    for (const runtime of Object.values(runtimes)) { runtime.process.end(result?.winner ?? null, reason); runtime.process.kill(); }
  };
  const complete = (status: MatchResult['status'], winner: Side | null, reason: string) => {
    if (finished) return;
    finished = true;
    result = { status, winner, reason: reason.slice(0, MAX_REASON), turn, teams: snapshotTeams(), inputLog: [...inputLog] };
  };
  const forfeit = async (side: Side, reason: string) => {
    if (finished || forfeitResult) return;
    const winner: Side = side === 'p1' ? 'p2' : 'p1';
    diagnostic(side, reason);
    forfeitResult = { winner, reason };
    try { await writeInput(`>forcewin ${winner}`); }
    catch { /* simulator may already be over */ }
  };
  const interrupt = (reason: string) => {
    if (finished) return;
    complete('interrupted', null, reason);
    void stream.writeEnd();
  };

  try {
    await Promise.all([
      runtimes.p1.process.initialize(options.matchId, options.policySeeds.p1, options.p1.config, limits.startupMs),
      runtimes.p2.process.initialize(options.matchId, options.policySeeds.p2, options.p2.config, limits.startupMs),
    ]);
    const p1Team = Teams.pack(Teams.generate(FORMAT, { seed: PRNG.convertSeed(teamSeed(options.seed, 0x13579bdf)) }));
    const p2Team = Teams.pack(Teams.generate(FORMAT, { seed: PRNG.convertSeed(teamSeed(options.seed, 0x2468ace0)) }));
    const start = JSON.stringify({ formatid: FORMAT, seed: options.seed });
    await writeInput(`>start ${start}\n>player p1 ${JSON.stringify({ name: playerNames.p1, team: p1Team })}\n>player p2 ${JSON.stringify({ name: playerNames.p2, team: p2Team })}`);
    (teams as unknown[]).push(...snapshotTeams());
  } catch (error) {
    void stream.writeEnd();
    stopProcesses('setup failed');
    return { status: 'interrupted', winner: null, reason: `setup failed: ${String(error).slice(0, MAX_REASON)}`, turn: 0, teams, inputLog };
  }

  const abortHandler = () => interrupt('cancelled');
  options.signal?.addEventListener('abort', abortHandler, { once: true });
  const watchdog = setTimeout(() => interrupt('match timeout'), limits.matchMs);
  const tasks = new Set<Promise<void>>();

  const handleSideChunk = (side: Side, chunk: string) => {
    if (finished || forfeitResult) return;
    const runtime = runtimes[side];
    const lines = chunk.split('\n').filter(Boolean);
    const hasSimulatorError = lines.some(line => line.startsWith('|error|'));
    if (runtime.pending?.action && !hasSimulatorError) runtime.pending = undefined;
    for (const line of lines) {
      if (line.startsWith('|turn|')) { const parsed = Number(line.slice(6)); if (Number.isFinite(parsed)) turn = parsed; }
      if (line.startsWith('|error|')) {
        const pending = runtime.pending;
        if (pending?.action) records({ kind: 'action', side, turn, at: new Date().toISOString(), data: { requestId: pending.requestId, action: pending.action, latencyMs: Date.now() - pending.startedAt, accepted: false } });
        if (!line.startsWith('|error|[Unavailable choice]')) interrupt(`simulator rejected choice: ${line.slice(7)}`);
        else if (pending) runtime.pending = { ...pending, retry: true, action: undefined };
        runtime.events.push(line);
        continue;
      }
      if (line.startsWith('|request|')) {
        let request: Record<string, unknown>;
        try { request = JSON.parse(line.slice(9)) as Record<string, unknown>; }
        catch { interrupt('malformed simulator request'); continue; }
        if (request.wait === true || request.teamPreview === true) { runtime.events = []; continue; }
        const legalActions = legalActionsForRequest(request);
        if (!legalActions.length) { interrupt('simulator supplied no legal actions'); continue; }
        const pending = runtime.pending;
        const retry = pending?.retry === true;
        const requestId = retry ? pending!.requestId : runtime.nextRequestId++;
        const startedAt = retry ? pending!.startedAt : Date.now();
        const deadlineMs = retry ? Math.max(1, limits.decisionMs - (Date.now() - startedAt)) : Math.max(1, limits.decisionMs);
        const observation: Observation = { protocolVersion: PROTOCOL_VERSION, matchId: options.matchId, side, formatId: FORMAT, turn, phase: 'battle', requestId, request, events: [...runtime.events], legalActions, deadline: new Date(Date.now() + deadlineMs).toISOString() };
        runtime.events = [];
        runtime.pending = { requestId, startedAt, retry };
        records({ kind: 'observation', side, turn, at: new Date().toISOString(), data: observation });
        const task = (async () => {
          const startedDecision = Date.now();
          try {
            const remainingTotal = Math.max(1, limits.totalDecisionMs - runtime.totalUsedMs);
            const response: DecisionResponse = await runtime.process.decide(observation, Math.min(deadlineMs, remainingTotal));
            const latencyMs = Date.now() - startedDecision;
            runtime.totalUsedMs += latencyMs;
            if (!validateAction(response.action, legalActions)) throw new Error('agent chose an unavailable action');
            if (finished) return;
            runtime.pending = { requestId, startedAt, action: response.action };
            records({ kind: 'action', side, turn, at: new Date().toISOString(), data: { requestId, action: response.action, latencyMs, accepted: true } });
            await writeInput(`>${side} ${actionToChoice(response.action)}`);
          } catch (error) { await forfeit(side, String(error)); }
          finally { if (!runtime.pending?.action || runtime.pending.requestId !== requestId) runtime.pending = undefined; }
        })();
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
      } else if (!line.startsWith('|request|')) runtime.events.push(line);
    }
  };

  for await (const event of eventQueue) {
    if (event.kind === 'public') {
      for (const line of event.chunk.split('\n').filter(Boolean)) {
        records({ kind: 'public', turn, at: new Date().toISOString(), data: line });
        if (line.startsWith('|turn|')) { const parsed = Number(line.slice(6)); if (Number.isFinite(parsed)) turn = parsed; }
        if (line.startsWith('|win|')) {
          const winner = line.slice(5) === playerNames.p1 ? 'p1' : line.slice(5) === playerNames.p2 ? 'p2' : null;
          const forcedReason = (forfeitResult as { reason: string } | null)?.reason;
          complete('completed', winner, forcedReason ? `battle complete (${forcedReason})` : 'battle complete');
        } else if (line === '|tie' || line === '|tie|') complete('completed', null, 'battle tied');
      }
    } else if (!finished) handleSideChunk(event.kind, event.chunk);
    if (finished) break;
  }
  clearTimeout(watchdog);
  options.signal?.removeEventListener('abort', abortHandler);
  if (!result && forfeitResult) {
    const forced = forfeitResult as { winner: Side; reason: string };
    result = { status: 'completed', winner: forced.winner, reason: `${forced.winner === 'p1' ? 'p2' : 'p1'} forfeited: ${forced.reason}`.slice(0, MAX_REASON), turn, teams: snapshotTeams(), inputLog: [...inputLog] };
  }
  if (!result && streamFailure) {
    result = { status: 'interrupted', winner: null, reason: `simulator stream failed: ${streamFailure}`.slice(0, MAX_REASON), turn, teams: snapshotTeams(), inputLog: [...inputLog] };
  }
  const finalResult = result as MatchResult | null;
  stopProcesses(finalResult?.reason ?? 'battle complete');
  await Promise.allSettled([...tasks]);
  return finalResult ?? { status: 'interrupted', winner: null, reason: 'simulator ended without result', turn, teams, inputLog };
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function teamSeed(seed: [number, number, number, number], salt: number): [number, number, number, number] {
  return seed.map((part, index) => ((part ^ (salt + index * 0x9e3779b9)) >>> 0)) as [number, number, number, number];
}
