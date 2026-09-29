// Local simulator throughput only; all choices are made by Showdown's random AI.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import showdown from 'pokemon-showdown';
import randomAI from 'pokemon-showdown/dist/sim/tools/random-player-ai.js';

const format = 'gen9championsvgc2026regmb';
const { BattleStream, getPlayerStreams, Teams, TeamValidator, Dex, toID } = showdown;
const { RandomPlayerAI } = randomAI;
const engineVersion = createRequire(import.meta.url)('pokemon-showdown/package.json').version;
assert.equal(engineVersion, '0.11.11', 'Revalidate this benchmark after changing simulator versions');
const games = Number(process.argv[2] ?? 200);
if (process.argv.length > 3 || !Number.isInteger(games) || games < 1 || games > 10000) {
  throw new Error('Usage: node scripts/benchmark-champions-vgc.mjs [games: 1..10000]');
}

// Champions Random teams can repeat items; VGC Reg M-B has Item Clause.
// Replace only duplicates with locally available non-Mega items, then validate.
const itemPool = Dex.forFormat(format).items.all()
  .filter(item => item.exists && !item.isNonstandard && !item.megaStone && !item.zMove)
  .map(item => item.name);
const teamValidator = new TeamValidator(format);
function makeTeam(seed) {
  const team = Teams.generate(format, { seed });
  const used = new Set();
  for (const pokemon of team) {
    if (used.has(toID(pokemon.item))) {
      pokemon.item = itemPool.find(item => !used.has(toID(item)));
      if (!pokemon.item) throw new Error('Could not assign unique legal items');
    }
    used.add(toID(pokemon.item));
  }
  const errors = teamValidator.validateTeam(team);
  if (errors) throw new Error(`Generated illegal team: ${errors.join('; ')}`);
  return Teams.pack(team);
}

class CountedRandom extends RandomPlayerAI {
  attempts = 0;
  retries = 0;
  megaAttempts = 0;
  switchAttempts = 0;
  choose(choice) {
    for (const action of choice.split(',').map(part => part.trim())) {
      this.attempts++;
      if (action.endsWith(' mega')) this.megaAttempts++;
      if (action.startsWith('switch ')) this.switchAttempts++;
    }
    super.choose(choice);
  }
  receiveError(error) {
    if (error.message.startsWith('[Unavailable choice]')) this.retries++;
    super.receiveError(error);
  }
}

async function battle(index) {
  const stream = new BattleStream();
  const streams = getPlayerStreams(stream);
  const seed = [17, 29, Math.floor(index / 65536), index % 65536];
  const buildStart = performance.now();
  const teams = ['p1', 'p2'].map((_, i) => makeTeam([71 + i, 89, seed[2], seed[3]]));
  const teamBuildSeconds = (performance.now() - buildStart) / 1000;
  const players = ['p1', 'p2'].map((side, i) => new CountedRandom(streams[side], {
    seed: [41 + i, 53, seed[2], seed[3]], move: 0.8, mega: 0.5,
  }));
  const digest = createHash('sha256');
  let turns = 0, winner = null, finished = false, truncated = false;
  const drains = ['omniscient', 'p3', 'p4'].map(async side => {
    for await (const _ of streams[side]) { /* discard unused streams */ }
  });
  const spectator = (async () => {
    for await (const chunk of streams.spectator) for (const line of chunk.split('\n')) {
      if (!line.startsWith('|t:|')) digest.update(`${line}\n`);
      if (line.startsWith('|turn|')) {
        turns = Number(line.slice(6));
        if (turns >= 400 && !truncated) {
          truncated = true;
          await stream.write('>forcetie');
        }
      }
      if (line.startsWith('|win|')) { winner = line.slice(5); finished = true; }
      if (line === '|tie' || line === '|tie|') finished = true;
    }
  })();
  const jobs = [...drains, spectator, ...players.map(player => player.start())];
  const timer = setTimeout(() => stream.pushError(new Error('Battle exceeded 30 seconds')), 30000);
  try {
    const setup = ['p1', 'p2'].map((side, i) => `>player ${side} ${JSON.stringify({
      name: side, team: teams[i], seed: [101 + i, 127, seed[2], seed[3]].join(','),
    })}`).join('\n');
    await stream.write(`>start ${JSON.stringify({ formatid: format, seed })}\n${setup}`);
    await Promise.all(jobs);
    assert.ok(finished, 'Simulator ended without a terminal result');
    return {
      turns, winner, truncated, digest: digest.digest('hex'), teamBuildSeconds,
      attempts: players.reduce((n, p) => n + p.attempts, 0),
      retries: players.reduce((n, p) => n + p.retries, 0),
      megaAttempts: players.reduce((n, p) => n + p.megaAttempts, 0),
      switchAttempts: players.reduce((n, p) => n + p.switchAttempts, 0),
    };
  } finally {
    clearTimeout(timer);
    await stream.writeEnd();
    await Promise.allSettled(jobs);
  }
}

const coldStart = performance.now();
const first = await battle(0);
const coldBattleSeconds = (performance.now() - coldStart) / 1000;
const repeated = await battle(0);
assert.deepEqual(
  { ...repeated, teamBuildSeconds: 0 },
  { ...first, teamBuildSeconds: 0 },
  'Identical seeds must reproduce results and spectator trace',
);
const results = [];
const start = performance.now();
for (let i = 1; i <= games; i++) results.push(await battle(i));
const seconds = (performance.now() - start) / 1000;
const sum = key => results.reduce((n, result) => n + Number(result[key]), 0);
const acceptedChoices = sum('attempts') - sum('retries');
const teamBuildSeconds = sum('teamBuildSeconds');
const report = {
  format, engineVersion, node: process.version, platform: `${process.platform}-${process.arch}`,
  policy: 'upstream RandomPlayerAI; move=0.8, mega=0.5',
  teams: 'local Showdown Champions random-set generator; duplicate items replaced to satisfy Item Clause; validated locally',
  workers: 1, games, seedIndices: [1, games], maxTurns: 400,
  deterministicReplayCheck: 'passed', coldBattleSeconds,
  seconds, gamesPerSecond: games / seconds,
  simulationOnlyGamesPerSecond: games / Math.max(0.001, seconds - teamBuildSeconds),
  teamBuildSeconds, meanTurns: sum('turns') / games,
  acceptedChoices, acceptedChoicesPerSecond: acceptedChoices / seconds,
  choiceAttempts: sum('attempts'), unavailableChoiceRetries: sum('retries'),
  megaAttempts: sum('megaAttempts'), switchAttempts: sum('switchAttempts'),
  truncated: sum('truncated'),
  wins: Object.fromEntries(['p1', 'p2'].map(side => [side,
    results.filter(r => !r.truncated && r.winner === side).length])),
  naturalDraws: results.filter(r => !r.truncated && r.winner === null).length,
  peakRssMiB: process.resourceUsage().maxRSS / 1024,
  note: 'Choices count both players; includes team generation and legality checks in games/sec, but excludes neural inference, IPC, and optimization. Truncations are not wins or draws.',
};
const out = fileURLToPath(new URL('../reports/champions-vgc-2026-reg-mb/', import.meta.url));
mkdirSync(out, { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-');
const reportPath = join(out, `benchmark-${stamp}.json`);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, reportPath }, null, 2));
