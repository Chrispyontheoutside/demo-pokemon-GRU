import { mkdir, writeFile } from 'node:fs/promises';
import showdown from 'pokemon-showdown';

const { Dex } = showdown;
const moves = Dex.moves.all()
  .filter(move => move.exists && !move.isNonstandard)
  .map(move => ({
    id: move.id,
    name: move.name,
    type: move.type,
    category: move.category,
    basePower: move.basePower,
    accuracy: move.accuracy,
    pp: move.pp,
    target: move.target,
    priority: move.priority,
    flags: move.flags,
  }))
  .sort((a, b) => a.id.localeCompare(b.id));

await mkdir(new URL('../agents/', import.meta.url), { recursive: true });
await writeFile(new URL('../agents/moves.json', import.meta.url), `${JSON.stringify({ formatId: 'gen9randombattle', moves }, null, 2)}\n`);
