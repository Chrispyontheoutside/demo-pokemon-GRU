import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import showdown from 'pokemon-showdown';
import { ENGINE_VERSION, FORMAT } from './contracts.js';
import type { MatchPrivate, MatchSummary, StoredRecord } from './contracts.js';

export interface Audit { match: MatchSummary; metadata: MatchPrivate; records: StoredRecord[] }
const { BattleStream } = showdown;

function validateInput(line: string): void {
  if (typeof line !== 'string' || /[\r\n]/.test(line)) throw new Error('Replay inputs must be single lines.');
  if (/^>p[12] (?:move [1-4](?: terastallize)?|switch [1-6])$/.test(line)) return;
  if (/^>forcewin p[12]$/.test(line) || line === '>forcetie') return;
  if (line.startsWith('>start ')) {
    const options = JSON.parse(line.slice(7));
    if (options.formatid !== FORMAT || Object.keys(options).some(key => !['formatid', 'seed'].includes(key))) throw new Error('Unsupported replay start options.');
    if (!Array.isArray(options.seed) || options.seed.length !== 4 || options.seed.some((v: unknown) => !Number.isInteger(v) || Number(v) < 0 || Number(v) > 65535)) throw new Error('Invalid battle seed.');
    return;
  }
  if (/^>player p[12] /.test(line)) {
    const options = JSON.parse(line.slice(11));
    if (typeof options.name !== 'string' || Object.keys(options).some(key => !['name', 'team'].includes(key))) throw new Error('Unsupported replay player options.');
    if (options.team !== undefined && typeof options.team !== 'string' && !Array.isArray(options.team)) throw new Error('Invalid replay team.');
    return;
  }
  throw new Error('Unsupported simulator input in audit.');
}

export async function verifyAudit(audit: Audit): Promise<{ lines: number; winner: string }> {
  if (audit.match?.engineVersion !== ENGINE_VERSION || audit.match?.formatId !== FORMAT) throw new Error('Audit requires a different engine version or format.');
  if (audit.match.status !== 'completed') throw new Error('Only completed matches have a complete reproducible battle trace.');
  const inputLog = audit.metadata?.inputLog;
  if (!Array.isArray(inputLog) || inputLog.length === 0) throw new Error('Audit is missing simulator inputs.');
  inputLog.forEach(validateInput);
  const stream = new BattleStream({ replay: 'spectator', noCatch: true });
  const actual: string[] = [];
  const gameplayLine = (line: string) => line.length > 0 && !line.startsWith('|t:|');
  const reading = (async () => { for await (const chunk of stream) actual.push(...chunk.split('\n').filter(gameplayLine)); })();
  const timer = setTimeout(() => { stream.pushError(new Error('Replay verification timed out.')); }, 30_000);
  try {
    await stream.write(inputLog.join('\n'));
    if (!stream.battle?.ended) throw new Error('Inputs did not finish the battle.');
    await reading;
    const expected = audit.records.filter(r => r.kind === 'public').flatMap(r => String(r.data).split('\n')).filter(gameplayLine);
    for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
      if (actual[i] !== expected[i]) throw new Error(`Replay diverged at line ${i + 1}: expected ${JSON.stringify(expected[i])}, got ${JSON.stringify(actual[i])}`);
    }
    return { lines: actual.length, winner: actual.find(line => line.startsWith('|win|'))?.slice(5) ?? 'tie' };
  } finally {
    clearTimeout(timer);
    await stream.writeEnd();
    await reading.catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = process.argv[2];
  if (!path) { console.error('Usage: npm run verify -- path/to/match.audit.json'); process.exitCode = 1; }
  else {
    verifyAudit(JSON.parse(readFileSync(resolve(path), 'utf8'))).then(result => {
      console.log(`Verified ${result.lines} spectator lines (excluding wall-clock timestamps). Result: ${result.winner}.`);
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
