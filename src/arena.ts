import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { runMatch } from './battle.js';
import { ArenaStore } from './store.js';
import { DEFAULT_LIMITS, ENGINE_VERSION, FORMAT } from './contracts.js';
import type { AgentDefinition, AgentInfo, ArenaState, Evaluation, MatchDetail, MatchPrivate, MatchSummary, Mode, QueueEntry, RunMatchOptions, MatchResult } from './contracts.js';
import type { RegisteredAgent } from './config.js';

function info(a: AgentDefinition): AgentInfo {
  return { id: a.id, name: a.name, version: a.version, configHash: a.configHash, ...(a.modelName ? { modelName: a.modelName } : {}) };
}
function seed(): [number, number, number, number] {
  const bytes = randomBytes(8);
  return [0, 2, 4, 6].map(offset => bytes.readUInt16BE(offset)) as [number, number, number, number];
}
interface EvaluationJob { evaluation: Evaluation; seed: MatchPrivate['seed'] }
export class ArenaInputError extends Error {}

export class Arena extends EventEmitter {
  readonly queue: QueueEntry[] = [];
  readonly evaluations: Evaluation[] = [];
  private evaluationJobs: EvaluationJob[] = [];
  private activeId: string | null = null;
  private activeController: AbortController | null = null;
  private running = false;
  private stopping = false;
  private pendingRun: Promise<void> | null = null;

  constructor(readonly store: ArenaStore, readonly agents: RegisteredAgent[], private readonly runner: (options: RunMatchOptions) => Promise<MatchResult> = runMatch) {
    super();
    store.recover();
    const grouped = new Map<string, MatchSummary[]>();
    for (const match of store.listMatches().slice().reverse()) {
      if (match.groupId) grouped.set(match.groupId, [...(grouped.get(match.groupId) ?? []), match]);
    }
    for (const [id, matches] of grouped) {
      this.evaluations.push({ id, p1Id: matches[0].p1.id, p2Id: matches[0].p2.id, matchIds: matches.map(m => m.id),
        status: matches.length === 2 && matches.every(m => m.status === 'completed') ? 'completed' : 'interrupted' });
    }
  }

  private agent(id: string): RegisteredAgent {
    const agent = this.agents.find(a => a.id === id);
    if (!agent) throw new ArenaInputError('Unknown registered agent.');
    return agent;
  }

  private occupied(id: string): boolean {
    const active = this.activeId ? this.store.getMatch(this.activeId) : undefined;
    return this.queue.some(e => e.agentId === id) || !!active && (active.p1.id === id || active.p2.id === id)
      || this.evaluations.some(e => (e.status === 'queued' || e.status === 'running') && (e.p1Id === id || e.p2Id === id));
  }

  state(): ArenaState {
    const activeMatch = this.activeId ? this.store.getMatch(this.activeId) ?? null : null;
    return { agents: this.agents.map(a => ({ ...info(a), description: a.description,
      state: activeMatch && (activeMatch.p1.id === a.id || activeMatch.p2.id === a.id) ? 'running' : this.occupied(a.id) ? 'queued' : 'idle' })),
      queue: this.queue.slice(), activeMatch, matches: this.store.listMatches(), leaderboard: this.store.leaderboard(),
      evaluations: this.evaluations.slice().reverse(), formatId: FORMAT, engineVersion: ENGINE_VERSION };
  }

  changed() { this.emit('state', this.state()); }

  enqueue(agentId: string, mode: Mode): void {
    if (this.stopping) throw new ArenaInputError('Arena is shutting down.');
    this.agent(agentId);
    if (mode !== 'ranked' && mode !== 'unranked') throw new ArenaInputError('Choose ranked or unranked.');
    if (this.occupied(agentId)) throw new ArenaInputError('This agent is already queued or playing.');
    this.queue.push({ agentId, mode, enteredAt: new Date().toISOString() });
    this.changed();
    this.schedule();
  }

  dequeue(agentId: string): void {
    const index = this.queue.findIndex(e => e.agentId === agentId);
    if (index < 0) throw new ArenaInputError('This agent is not in a regular queue.');
    this.queue.splice(index, 1);
    this.changed();
  }

  evaluate(p1Id: string, p2Id: string): string {
    if (this.stopping) throw new ArenaInputError('Arena is shutting down.');
    this.agent(p1Id); this.agent(p2Id);
    if (p1Id === p2Id) throw new ArenaInputError('Select two different agents.');
    if (this.occupied(p1Id) || this.occupied(p2Id)) throw new ArenaInputError('Both agents must be idle.');
    const evaluation: Evaluation = { id: randomUUID(), p1Id, p2Id, matchIds: [], status: 'queued' };
    this.evaluations.push(evaluation);
    this.evaluationJobs.push({ evaluation, seed: seed() });
    this.changed(); this.schedule();
    return evaluation.id;
  }

  cancel(id: string): void {
    if (id !== this.activeId) throw new ArenaInputError('This match is not running.');
    this.activeController?.abort(new Error('Cancelled by operator'));
  }

  auditAvailable(id: string): boolean {
    const match = this.store.getMatch(id);
    if (!match || match.status === 'running') return false;
    const evaluation = match.groupId ? this.evaluations.find(e => e.id === match.groupId) : undefined;
    return !evaluation || evaluation.status === 'completed' || evaluation.status === 'interrupted';
  }

  detail(id: string): MatchDetail | undefined {
    const match = this.store.getMatch(id);
    if (!match) return undefined;
    const auditAvailable = this.auditAvailable(id);
    return { match, auditAvailable, evaluation: this.evaluations.find(e => e.id === match.groupId) ?? null,
      records: this.store.getRecords(id).filter(r => r.kind === 'public' || auditAvailable && r.kind !== 'input') };
  }

  private schedule(): void {
    if (this.running || this.stopping) return;
    this.running = true;
    this.pendingRun = this.drain().catch(error => {
      this.emit('arena-error', error);
    }).finally(() => {
      this.running = false; this.pendingRun = null; this.changed();
      if (!this.stopping && (this.evaluationJobs.length || this.queue.some((entry, i) => this.queue.some((other, j) => j > i && other.mode === entry.mode)))) this.schedule();
    });
  }

  private nextPair(): QueueEntry[] | null {
    for (let i = 0; i < this.queue.length; i++) {
      const j = this.queue.findIndex((e, index) => index > i && e.mode === this.queue[i].mode);
      if (j >= 0) {
        const second = this.queue.splice(j, 1)[0];
        const first = this.queue.splice(i, 1)[0];
        return [first, second];
      }
    }
    return null;
  }

  private async drain(): Promise<void> {
    while (!this.stopping) {
      const job = this.evaluationJobs.shift();
      if (job) {
        job.evaluation.status = 'running';
        for (const [p1, p2] of [[job.evaluation.p1Id, job.evaluation.p2Id], [job.evaluation.p2Id, job.evaluation.p1Id]]) {
          const result = await this.play(p1, p2, 'unranked', job.seed, job.evaluation);
          if (result.status !== 'completed' || this.stopping) { job.evaluation.status = 'interrupted'; break; }
        }
        if (job.evaluation.status === 'running') job.evaluation.status = 'completed';
        this.changed();
        for (const matchId of job.evaluation.matchIds) this.emit('finished', { matchId });
        continue;
      }
      const pair = this.nextPair();
      if (!pair) return;
      await this.play(pair[0].agentId, pair[1].agentId, pair[0].mode, seed());
    }
  }

  private async play(p1Id: string, p2Id: string, mode: Mode, battleSeed: MatchPrivate['seed'], evaluation?: Evaluation): Promise<MatchSummary> {
    const p1 = this.agent(p1Id), p2 = this.agent(p2Id), id = randomUUID();
    const metadata: MatchPrivate = { seed: battleSeed, policySeeds: { p1: randomBytes(4).readUInt32BE(), p2: randomBytes(4).readUInt32BE() },
      agents: { p1, p2 }, limits: { ...DEFAULT_LIMITS } };
    const summary: MatchSummary = { id, groupId: evaluation?.id ?? null, formatId: FORMAT, engineVersion: ENGINE_VERSION,
      mode, status: 'running', p1: info(p1), p2: info(p2), winner: null, reason: null, turn: 0, startedAt: new Date().toISOString(), endedAt: null };
    this.store.createMatch(summary, metadata);
    evaluation?.matchIds.push(id);
    this.activeId = id;
    this.activeController = new AbortController();
    this.changed();
    let result: MatchResult;
    try {
      result = await this.runner({ matchId: id, p1, p2, seed: battleSeed, policySeeds: metadata.policySeeds,
        limits: metadata.limits, signal: this.activeController.signal, onRecord: record => {
          const stored = this.store.appendRecord(id, record);
          if (record.kind === 'public') this.emit('match', { matchId: id, record: stored });
        } });
    } catch (error) {
      result = { status: 'interrupted', winner: null, reason: `Arena error: ${error instanceof Error ? error.message : String(error)}`, turn: this.store.getMatch(id)?.turn ?? 0, teams: null, inputLog: [] };
    }
    const finished = this.store.finishMatch(id, result);
    this.activeId = null; this.activeController = null;
    this.changed();
    if (!evaluation) this.emit('finished', { matchId: id });
    return finished;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.queue.length = 0;
    for (const { evaluation } of this.evaluationJobs) evaluation.status = 'interrupted';
    this.evaluationJobs.length = 0;
    this.activeController?.abort(new Error('Arena shutting down'));
    await this.pendingRun;
  }
}
