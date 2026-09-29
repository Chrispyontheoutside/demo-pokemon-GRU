export const FORMAT = 'gen9randombattle';
export const ENGINE_VERSION = '0.11.11';
export const PROTOCOL_VERSION = 1;
export type Side = 'p1' | 'p2';
export type Mode = 'ranked' | 'unranked';
export type MatchStatus = 'running' | 'completed' | 'interrupted';
export type Action = { type: 'move'; slot: number; gimmick?: 'terastallize' } | { type: 'switch'; slot: number };
export interface AgentDefinition {
  id: string; name: string; version: string; command: string; args: string[]; cwd: string;
  config: Record<string, unknown>; configHash: string; modelName?: string;
}
export interface AgentInfo {
  id: string; name: string; version: string; configHash: string; modelName?: string;
}
export interface Observation {
  protocolVersion: 1; matchId: string; side: Side; formatId: string; turn: number;
  phase: 'battle'; requestId: number;
  request: Record<string, unknown>; events: string[]; legalActions: Action[]; deadline: string;
}
export interface DecisionResponse { requestId: number; action: Action }
export interface Limits { startupMs: number; decisionMs: number; totalDecisionMs: number; matchMs: number }
export const DEFAULT_LIMITS: Limits = { startupMs: 10_000, decisionMs: 10_000, totalDecisionMs: 300_000, matchMs: 900_000 };
export interface MatchSummary {
  id: string; groupId: string | null; formatId: string; engineVersion: string; mode: Mode;
  status: MatchStatus; p1: AgentInfo; p2: AgentInfo; winner: Side | null; reason: string | null;
  turn: number; startedAt: string; endedAt: string | null;
  ratingChanges?: { p1: number; p2: number };
}
export interface MatchRecord {
  kind: 'public' | 'observation' | 'action' | 'diagnostic' | 'input';
  side?: Side; turn: number; at: string; data: unknown;
}
export interface StoredRecord extends MatchRecord { seq: number; matchId: string }
export interface MatchResult {
  status: 'completed' | 'interrupted'; winner: Side | null; reason: string; turn: number;
  teams: unknown; inputLog: string[];
}
export interface MatchPrivate {
  seed: [number, number, number, number]; policySeeds: { p1: number; p2: number };
  agents: { p1: AgentDefinition; p2: AgentDefinition }; limits: Limits;
  teams?: unknown; inputLog?: string[];
}
export interface RunMatchOptions {
  matchId: string; p1: AgentDefinition; p2: AgentDefinition;
  seed: [number, number, number, number]; policySeeds: { p1: number; p2: number };
  limits?: Partial<Limits>; signal?: AbortSignal; onRecord: (record: MatchRecord) => void;
}
export interface QueueEntry { agentId: string; mode: Mode; enteredAt: string }
export interface Evaluation {
  id: string; p1Id: string; p2Id: string; matchIds: string[];
  status: 'queued' | 'running' | 'completed' | 'interrupted';
}
export interface AgentView extends AgentInfo { state: 'idle' | 'queued' | 'running'; description?: string }
export interface LeaderboardEntry extends AgentInfo {
  rating: number; games: number; wins: number; losses: number; draws: number; medianLatencyMs: number | null;
}
export interface ArenaState {
  agents: AgentView[]; queue: QueueEntry[]; activeMatch: MatchSummary | null;
  matches: MatchSummary[]; leaderboard: LeaderboardEntry[]; evaluations: Evaluation[];
  formatId: string; engineVersion: string;
}
export interface MatchDetail {
  match: MatchSummary; records: StoredRecord[]; auditAvailable: boolean;
  evaluation: Evaluation | null;
}
