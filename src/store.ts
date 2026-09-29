import { DatabaseSync } from 'node:sqlite';
import type {
  AgentInfo, LeaderboardEntry, MatchPrivate, MatchRecord, MatchResult, MatchSummary, MatchStatus, StoredRecord,
} from './contracts.js';

type SqlRow = Record<string, unknown>;

const INITIAL_RATING = 1000;
const K_FACTOR = 32;

function json(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

function parse<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function agentKey(agent: AgentInfo, formatId: string, engineVersion: string): [string, string, string, string, string] {
  return [agent.id, agent.version, agent.configHash, formatId, engineVersion];
}

function rowAgent(row: SqlRow): AgentInfo {
  return {
    id: String(row.agent_id), name: String(row.name), version: String(row.version), configHash: String(row.config_hash),
    ...(row.model_name === null ? {} : { modelName: String(row.model_name) }),
  };
}

function summaryFromRow(row: SqlRow): MatchSummary {
  return parse<MatchSummary>(row.summary_json);
}

export class ArenaStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 5_000 });
    this.db.exec('PRAGMA foreign_keys = ON;');
    const version = Number((this.db.prepare('PRAGMA user_version').get() as SqlRow).user_version);
    if (version > 1) throw new Error(`Unsupported arena database version: ${version}`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        group_id TEXT,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        turn INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        rating_applied INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS matches_started_at ON matches(started_at);
      CREATE TABLE IF NOT EXISTS records (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT NOT NULL REFERENCES matches(id),
        kind TEXT NOT NULL,
        side TEXT,
        turn INTEGER NOT NULL,
        at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_match_seq ON records(match_id, seq);
      CREATE TABLE IF NOT EXISTS ratings (
        agent_id TEXT NOT NULL,
        version TEXT NOT NULL,
        config_hash TEXT NOT NULL,
        format_id TEXT NOT NULL,
        engine_version TEXT NOT NULL,
        name TEXT NOT NULL,
        model_name TEXT,
        rating REAL NOT NULL DEFAULT 1000,
        games INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        draws INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, version, config_hash, format_id, engine_version)
      );
    `);
    if (version === 0) this.db.exec('PRAGMA user_version = 1;');
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createMatch(summary: MatchSummary, metadata: MatchPrivate): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO matches (id, group_id, mode, status, turn, started_at, summary_json, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(summary.id, summary.groupId, summary.mode, summary.status, summary.turn, summary.startedAt, json(summary), json(metadata));
    });
  }

  appendRecord(matchId: string, record: MatchRecord): StoredRecord {
    return this.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO records (match_id, kind, side, turn, at, data_json) VALUES (?, ?, ?, ?, ?, ?)
      `).run(matchId, record.kind, record.side ?? null, record.turn, record.at, json(record.data));
      const seq = Number(result.lastInsertRowid);
      if (record.kind === 'public' && typeof record.data === 'string') {
        const marker = /^\|turn\|(\d+)(?:\||$)/.exec(record.data);
        if (marker) {
          const turn = Number(marker[1]);
          const row = this.db.prepare('SELECT summary_json FROM matches WHERE id = ?').get(matchId) as SqlRow | undefined;
          if (!row) throw new Error(`Unknown match: ${matchId}`);
          const summary = summaryFromRow(row);
          if (turn > summary.turn) {
            summary.turn = turn;
            this.db.prepare('UPDATE matches SET turn = ?, summary_json = ? WHERE id = ?').run(turn, json(summary), matchId);
          }
        }
      }
      return { ...record, seq, matchId };
    });
  }

  finishMatch(id: string, result: MatchResult): MatchSummary {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM matches WHERE id = ?').get(id) as SqlRow | undefined;
      if (!row) throw new Error(`Unknown match: ${id}`);
      const current = summaryFromRow(row);
      if (current.status !== 'running') return current;

      const metadata = parse<MatchPrivate>(row.metadata_json);
      metadata.teams = result.teams;
      metadata.inputLog = result.inputLog;
      const finished: MatchSummary = {
        ...current,
        status: result.status,
        winner: result.winner,
        reason: result.reason,
        turn: Math.max(current.turn, result.turn),
        endedAt: new Date().toISOString(),
      };

      if (result.status === 'completed' && current.mode === 'ranked' && Number(row.rating_applied) === 0) {
        const changes = this.applyRating(finished);
        finished.ratingChanges = changes;
        this.db.prepare('UPDATE matches SET rating_applied = 1 WHERE id = ?').run(id);
      }
      this.db.prepare(`
        UPDATE matches SET status = ?, turn = ?, summary_json = ?, metadata_json = ? WHERE id = ?
      `).run(finished.status, finished.turn, json(finished), json(metadata), id);
      return finished;
    });
  }

  private applyRating(summary: MatchSummary): { p1: number; p2: number } {
    const p1Key = agentKey(summary.p1, summary.formatId, summary.engineVersion);
    const p2Key = agentKey(summary.p2, summary.formatId, summary.engineVersion);
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO ratings
        (agent_id, version, config_hash, format_id, engine_version, name, model_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(...p1Key, summary.p1.name, summary.p1.modelName ?? null);
    insert.run(...p2Key, summary.p2.name, summary.p2.modelName ?? null);
    const select = this.db.prepare(`
      SELECT rating FROM ratings
      WHERE agent_id = ? AND version = ? AND config_hash = ? AND format_id = ? AND engine_version = ?
    `);
    const p1Rating = Number((select.get(...p1Key) as SqlRow).rating);
    const p2Rating = Number((select.get(...p2Key) as SqlRow).rating);
    const expected1 = 1 / (1 + 10 ** ((p2Rating - p1Rating) / 400));
    const score1 = summary.winner === 'p1' ? 1 : summary.winner === 'p2' ? 0 : 0.5;
    const p1Change = K_FACTOR * (score1 - expected1);
    const p2Change = p1Change === 0 ? 0 : -p1Change;
    const update = this.db.prepare(`
      UPDATE ratings
      SET rating = ?, games = games + 1, wins = wins + ?, losses = losses + ?, draws = draws + ?,
          name = ?, model_name = ?
      WHERE agent_id = ? AND version = ? AND config_hash = ? AND format_id = ? AND engine_version = ?
    `);
    const outcome = (score: number) => ({ wins: score === 1 ? 1 : 0, losses: score === 0 ? 1 : 0, draws: score === 0.5 ? 1 : 0 });
    const o1 = outcome(score1), o2 = outcome(1 - score1);
    update.run(p1Rating + p1Change, o1.wins, o1.losses, o1.draws, summary.p1.name, summary.p1.modelName ?? null, ...p1Key);
    update.run(p2Rating + p2Change, o2.wins, o2.losses, o2.draws, summary.p2.name, summary.p2.modelName ?? null, ...p2Key);
    return { p1: p1Change, p2: p2Change };
  }

  getMatch(id: string): MatchSummary | undefined {
    const row = this.db.prepare('SELECT summary_json FROM matches WHERE id = ?').get(id) as SqlRow | undefined;
    return row ? summaryFromRow(row) : undefined;
  }

  listMatches(): MatchSummary[] {
    return (this.db.prepare('SELECT summary_json FROM matches ORDER BY rowid DESC').all() as SqlRow[]).map(summaryFromRow);
  }

  getRecords(id: string): StoredRecord[] {
    return (this.db.prepare(`SELECT seq, match_id, kind, side, turn, at, data_json FROM records WHERE match_id = ? ORDER BY seq`).all(id) as SqlRow[])
      .map(row => ({ seq: Number(row.seq), matchId: String(row.match_id), kind: row.kind as StoredRecord['kind'], ...(row.side === null ? {} : { side: row.side as StoredRecord['side'] }), turn: Number(row.turn), at: String(row.at), data: parse(row.data_json) }));
  }

  getPrivate(id: string): MatchPrivate | undefined {
    const row = this.db.prepare('SELECT metadata_json FROM matches WHERE id = ?').get(id) as SqlRow | undefined;
    return row ? parse<MatchPrivate>(row.metadata_json) : undefined;
  }

  leaderboard(): LeaderboardEntry[] {
    const rows = this.db.prepare('SELECT * FROM ratings ORDER BY rating DESC, agent_id').all() as SqlRow[];
    const matches = this.listMatches();
    const latencyByKey = new Map<string, number[]>();
    for (const match of matches) {
      if (match.mode !== 'ranked') continue;
      const records = this.getRecords(match.id);
      for (const side of ['p1', 'p2'] as const) {
        const agent = match[side];
        const key = agentKey(agent, match.formatId, match.engineVersion).join('\0');
        const values = records.filter(record => record.kind === 'action' && record.side === side && isAcceptedAction(record.data))
          .map(record => Number((record.data as { latencyMs: number }).latencyMs)).filter(Number.isFinite);
        if (values.length) latencyByKey.set(key, [...(latencyByKey.get(key) ?? []), ...values]);
      }
    }
    return rows.map(row => {
      const agent = rowAgent(row);
      const values = (latencyByKey.get([String(row.agent_id), String(row.version), String(row.config_hash), String(row.format_id), String(row.engine_version)].join('\0')) ?? []).sort((a, b) => a - b);
      const middle = Math.floor(values.length / 2);
      const medianLatencyMs = values.length ? (values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2) : null;
      return { ...agent, rating: Number(row.rating), games: Number(row.games), wins: Number(row.wins), losses: Number(row.losses), draws: Number(row.draws), medianLatencyMs };
    });
  }

  recover(): void {
    this.transaction(() => {
      const rows = this.db.prepare("SELECT id, summary_json FROM matches WHERE status = 'running'").all() as SqlRow[];
      const endedAt = new Date().toISOString();
      const update = this.db.prepare('UPDATE matches SET status = ?, summary_json = ? WHERE id = ?');
      for (const row of rows) {
        const summary = summaryFromRow(row);
        summary.status = 'interrupted';
        summary.endedAt = endedAt;
        summary.reason = 'recovered after restart';
        update.run('interrupted', json(summary), String(row.id));
      }
    });
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

function isAcceptedAction(data: unknown): data is { accepted: true; latencyMs: number } {
  return !!data && typeof data === 'object' && !Array.isArray(data) &&
    (data as Record<string, unknown>).accepted === true && typeof (data as Record<string, unknown>).latencyMs === 'number';
}
