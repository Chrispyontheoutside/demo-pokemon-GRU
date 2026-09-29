import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {createHash, randomInt} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import showdown from 'pokemon-showdown';
import {CHAMPIONS_FORMAT, encode, VisibleState, type SideId} from './champions.js';
import {makeTeam, Policy, type Checkpoint} from './champions-worker.js';

const userid = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
type Request = {rqid: number; side: {id: SideId}; wait?: boolean; [key: string]: any};

export class OnlineChampionsBattle {
  view = new VisibleState();
  request?: Request;
  sent = '';
  winner?: string;
  players: Record<string, string> = {};
  decisions: {turn: number; rqid: number; choice: string; decidedAt: string; inferenceMs: number}[] = [];
  log: string[] = [];
  finished = false;

  receive(lines: string[], policy: Policy, random = Math.random): string | undefined {
    for (const line of lines) {
      if (line.startsWith('|request|')) {
        const json = line.slice(9);
        if (json && json !== 'null') this.request = JSON.parse(json);
      } else {
        if (!/^\|(c|c:|chat|j|J|l|L|n|N|request)\|/.test(line)) this.log.push(line);
        this.view.receive(line);
        const [, cmd, a, b] = line.split('|');
        if (cmd === 'player' && b) this.players[a] = b;
        if (cmd === 'win') this.winner = a;
        if (cmd === 'tie') this.winner = '';
        if (cmd === 'error') this.sent = '';
      }
    }
    const request = this.request;
    if (this.winner !== undefined || !request || request.wait) return;
    const fingerprint = JSON.stringify(request);
    if (fingerprint === this.sent) return;
    if (!['p1', 'p2'].includes(request.side?.id) || !Number.isInteger(request.rqid)) throw new Error('Malformed Champions battle request');
    const started = performance.now();
    const encoded = encode(request, this.view, request.side.id);
    const {action} = policy.choose(encoded, random);
    const choice = encoded.candidates[action]?.choice;
    if (!choice) throw new Error('Policy returned an unavailable Champions action');
    this.sent = fingerprint;
    this.decisions.push({turn:this.view.turn,rqid:request.rqid,choice,decidedAt:new Date().toISOString(),inferenceMs:performance.now()-started});
    return `/choose ${choice}|${request.rqid}`;
  }
}

async function main() {
  const count = Number(process.argv[2] ?? 2);
  const checkpointPath = process.argv[3] ?? 'runs/champions-vgc-2026-reg-mb/seed-20260946/policy.json';
  if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error('Use 1–3 games for a bounded Champions ladder trial');
  const rawModel = readFileSync(checkpointPath, 'utf8');
  const checkpoint = JSON.parse(rawModel) as Checkpoint;
  const policy = new Policy(checkpoint);
  if (checkpoint.format !== CHAMPIONS_FORMAT) throw new Error(`Expected ${CHAMPIONS_FORMAT}`);

  const identityPath = '.cache/champions-vgc-2026-reg-mb-ladder-user.json';
  mkdirSync('.cache', {recursive: true});
  const identity = existsSync(identityPath)
    ? JSON.parse(readFileSync(identityPath, 'utf8')) as {name: string}
    : {name: `ChampionsMB${randomInt(100000, 999999)}`};
  if (!existsSync(identityPath)) writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
  const name = identity.name;
  const serverUrl = process.env.SHOWDOWN_SERVER ?? 'wss://sim3.psim.us/showdown/websocket';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = `runs/champions-vgc-2026-reg-mb/ladder/${stamp}`;
  mkdirSync(directory, {recursive: true});
  const modelSHA256 = createHash('sha256').update(rawModel).digest('hex');
  const team = makeTeam([31, 41, randomInt(0, 65536), randomInt(0, 65536)]);
  const results: object[] = [];
  const battles = new Map<string, OnlineChampionsBattle>();
  let named = false, stopped = false, searching = false, deadline = Date.now() + 60000;
  const ws = new WebSocket(serverUrl);
  const send = (command: string, room = '') => ws.send(`${room}|${command}`);
  const save = (reason?: string) => writeFileSync(`${directory}/summary.json`, JSON.stringify({
    name, format: CHAMPIONS_FORMAT, checkpointPath, checkpointSHA256: modelSHA256,
    modelSteps: checkpoint.steps, selfPlayBattlesGenerated: checkpoint.selfPlayBattlesGenerated,
    simpleScoreWeight: checkpoint.simpleScoreWeight ?? 0, requestedGames: count, results, reason,
  }, null, 2));
  const updateLedger = (increments: Record<string, number>) => {
    const path = 'reports/champions-vgc-2026-reg-mb/experiment-ledger.json';
    const ledger = JSON.parse(readFileSync(path, 'utf8'));
    for (const [key, value] of Object.entries(increments)) ledger[key] = Number(ledger[key] ?? 0) + value;
    ledger.lastUpdatedAt = new Date().toISOString();
    writeFileSync(`${path}.tmp`, `${JSON.stringify(ledger, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
  };
  const stop = (reason: string, failure = false) => {
    if (stopped) return;
    stopped = true;
    if (ws.readyState === WebSocket.OPEN) {
      send('/cancelsearch');
      for (const [room, battle] of battles) if (battle.winner === undefined) send('/forfeit', room);
      ws.close();
    }
    save(reason);
    console.log(`${reason} Results: ${directory}/summary.json`);
    clearInterval(watchdog);
    if (failure) process.exitCode = 1;
    setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
  };
  const search = () => {
    searching = true;
    deadline = Date.now() + 180000;
    send(`/search ${CHAMPIONS_FORMAT}`);
    console.log(`Searching ${CHAMPIONS_FORMAT} as ${name} (${results.length + 1}/${count})`);
  };
  const watchdog = setInterval(() => {
    if (Date.now() > deadline) stop(searching ? 'No opponent found within three minutes' : 'Connection or battle progress timed out', true);
  }, 1000);
  process.once('SIGINT', () => stop('Trial interrupted'));
  process.once('SIGTERM', () => stop('Trial interrupted'));
  ws.addEventListener('error', () => stop('WebSocket connection failed', true));
  ws.addEventListener('close', event => { if (!stopped) stop(`Server disconnected (${event.code})`, true); });
  let queue = Promise.resolve();
  ws.addEventListener('message', event => {
    queue = queue.then(async () => {
      if (stopped) return;
      const receivedAt = new Date().toISOString();
      const lines = String(event.data).split('\n');
      const room = lines[0].startsWith('>') ? lines.shift()!.slice(1) : '';
      if (!room) {
        for (const line of lines) {
          if (line.startsWith('|challstr|')) {
            const query = new URLSearchParams({act:'getassertion',userid:userid(name),challstr:line.slice(10)});
            const response = await fetch(`https://play.pokemonshowdown.com/~~showdown/action.php?${query}`, {signal:AbortSignal.timeout(20000)});
            const assertion = (await response.text()).trim();
            if (!response.ok || !assertion || assertion.startsWith(';') || assertion.startsWith('<')) {
              throw new Error(`Guest authentication unavailable (HTTP ${response.status})`);
            }
            send(`/trn ${name},0,${assertion}`);
          }
          if (line.startsWith('|updateuser|')) {
            const [, , user, isNamed] = line.split('|');
            if (!named && isNamed === '1' && userid(user) === userid(name)) {
              named = true;
              send(`/utm ${team}`);
              search();
            }
          }
          if (/^\|(nametaken|popup|error)\|/.test(line)) throw new Error(`Server: ${line}`);
        }
        return;
      }
      if (!room.startsWith(`battle-${CHAMPIONS_FORMAT}-`)) return;
      let battle = battles.get(room);
      if (!battle) {
        battle = new OnlineChampionsBattle();
        battles.set(room, battle);
        searching = false;
        deadline = Date.now() + 360000;
        updateLedger({ladderBattlesStarted:1});
        console.log(`Battle started: https://play.pokemonshowdown.com/${room}`);
        send('/timer on', room);
      }
      if (battle.finished) return;
      const choice = battle.receive(lines, policy);
      writeFileSync(`${directory}/${room}.log`, battle.log.join('\n'));
      if (choice) {
        send(choice, room);
        deadline = Date.now() + 360000;
        console.log(JSON.stringify({room,receivedAt,sentAt:new Date().toISOString(),...battle.decisions.at(-1)}));
        writeFileSync(`${directory}/${room}.decisions.json`, JSON.stringify(battle.decisions, null, 2));
      }
      for (const line of lines) if (line.startsWith('|error|')) throw new Error(`Battle rejected action: ${line}`);
      if (battle.winner !== undefined) {
        battle.finished = true;
        const outcome = !battle.winner ? 'tie' : userid(battle.winner) === userid(name) ? 'win' : 'loss';
        const ratingMessages = battle.log.filter(line => /rating/i.test(line));
        const ownRatingMessage = [...ratingMessages].reverse().find(line => line.toLowerCase().includes(userid(name)));
        const ratingAfter = ownRatingMessage?.match(/<strong>(\d+)<\/strong>/)?.[1];
        const result = {room,players:battle.players,winner:battle.winner,outcome,turns:battle.view.turn,
          decisions:battle.decisions.length,ratingMessages,ratingAfter:ratingAfter ? Number(ratingAfter) : null};
        results.push(result);
        updateLedger({ladderBattlesCompleted:1,ladderWins:Number(outcome === 'win'),ladderLosses:Number(outcome === 'loss'),ladderTies:Number(outcome === 'tie')});
        save();
        writeFileSync(`${directory}/${room}.decisions.json`, JSON.stringify(battle.decisions, null, 2));
        console.log(JSON.stringify(result));
        if (results.length >= count) stop('Trial complete');
        else { send('/leave', room); search(); }
      }
    }).catch(error => stop(error.message, true));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {console.error(error.message);process.exitCode=1;});
