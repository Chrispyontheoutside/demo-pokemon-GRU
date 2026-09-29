import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { AgentDefinition } from './contracts.js';

export interface RegisteredAgent extends AgentDefinition { description?: string }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function loadAgents(path: string, root: string): RegisteredAgent[] {
  const rows: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Agent configuration must be a nonempty array.');
  const ids = new Set<string>();
  return rows.map((row: unknown) => {
    if (!row || typeof row !== 'object') throw new Error('Invalid agent definition.');
    const a = row as Record<string, unknown>;
    for (const field of ['id', 'name', 'version', 'command', 'cwd']) {
      if (typeof a[field] !== 'string' || !(a[field] as string).trim() || /[\r\n\0]/.test(a[field] as string)) throw new Error(`Agent ${field} must be a nonempty single-line string.`);
    }
    const id = a.id as string;
    if ((a.name as string).length > 64 || /[|\x00-\x1f]/.test(a.name as string)) throw new Error('Agent name must be at most 64 characters without protocol delimiters.');
    if (!/^[a-z0-9_-]{1,64}$/.test(id) || ids.has(id)) throw new Error(`Duplicate or invalid agent ID: ${id}`);
    ids.add(id);
    if (!Array.isArray(a.args) || a.args.some(v => typeof v !== 'string')) throw new Error(`Agent ${id}: args must be a string array.`);
    if (!a.config || typeof a.config !== 'object' || Array.isArray(a.config)) throw new Error(`Agent ${id}: config must be an object.`);
    if (a.modelName !== undefined && typeof a.modelName !== 'string') throw new Error(`Agent ${id}: invalid modelName.`);
    if (a.description !== undefined && typeof a.description !== 'string') throw new Error(`Agent ${id}: invalid description.`);
    const configHash = createHash('sha256').update(canonical({ command: a.command, args: a.args, cwd: a.cwd, config: a.config, modelName: a.modelName ?? null })).digest('hex');
    return { id, name: a.name as string, version: a.version as string, command: a.command as string,
      args: a.args as string[], cwd: resolve(root, a.cwd as string), config: a.config as Record<string, unknown>, configHash,
      ...(a.modelName ? { modelName: a.modelName as string } : {}), ...(a.description ? { description: a.description as string } : {}) };
  });
}
