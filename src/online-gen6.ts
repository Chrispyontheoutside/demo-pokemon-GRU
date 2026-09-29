import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash, randomInt} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {GEN6, Policy, VisibleState, encode, type Gen6Request} from './gen6.js';

const userid = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
type Request = Gen6Request & {rqid: number; side: Gen6Request['side'] & {id: 'p1' | 'p2'}};

// One live battle at a time; reuse the exact local observation and policy code.
export class OnlineBattle {
  view = new VisibleState();
  request?: Request;
  sent = '';
  winner?: string;
  players: Record<string, string> = {};
  decisions: {turn: number; rqid: number; choice: string; decidedAt: string; inferenceMs: number}[] = [];
  log: string[] = [];
  receive(lines: string[], policy: Policy, random = Math.random): string | undefined {
    for (const line of lines) {
      if (line.startsWith('|request|')) {
        const json = line.slice(9);
        if (json && json !== 'null') this.request = JSON.parse(json);
      } else {
        // Keep battle events, not spectator chat or private authentication data.
        if (!/^\|(c|c:|chat|j|J|l|L|n|N)\|/.test(line)) this.log.push(line);
        this.view.receive(line);
        const [,cmd, a, b] = line.split('|');
        if (cmd === 'player' && b) this.players[a] = b;
        if (cmd === 'win') this.winner = a;
        if (cmd === 'tie') this.winner = '';
      }
    }
    const request = this.request;
    if (this.winner !== undefined || !request || request.wait) return;
    const fingerprint = JSON.stringify(request);
    if (fingerprint === this.sent) return;
    if (!['p1','p2'].includes(request.side?.id) || !Number.isInteger(request.rqid)) throw new Error('Malformed battle request');
    const started = performance.now();
    const encoded = encode(this.view, request, request.side.id);
    const action = policy.choose(encoded, random).action;
    const choice = encoded.candidates.find(c => c.index === action)!.choice;
    this.sent = fingerprint;
    this.decisions.push({turn: this.view.turn, rqid: request.rqid, choice, decidedAt: new Date().toISOString(), inferenceMs: performance.now() - started});
    return `/choose ${choice}|${request.rqid}`;
  }
}

async function main() {
  const count = Number(process.argv[2] ?? 2);
  if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error('Use 1–3 games for a bounded public trial');
  const model = readFileSync('models/gen6-policy.json', 'utf8');
  const policy = new Policy(JSON.parse(model));
  const name = `G6LearnerBot${randomInt(1000, 10000)}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = `.cache/online-${stamp}`;
  mkdirSync(directory, {recursive: true});
  const results: object[] = [];
  const battles = new Map<string, OnlineBattle>();
  let named = false, stopped = false, searching = false, deadline = Date.now() + 60000;
  const ws = new WebSocket('wss://sim3.psim.us/showdown/websocket');
  const send = (command: string, room = '') => ws.send(`${room}|${command}`);
  const save = (reason?: string) => writeFileSync(`${directory}/summary.json`, JSON.stringify({
    name, format: GEN6, modelSHA256: createHash('sha256').update(model).digest('hex'),
    modelSteps: policy.checkpoint.steps, requestedGames: count, results, reason,
  }, null, 2));
  const stop = (reason: string, failure = false) => {
    if (stopped) return;
    stopped = true;
    if (ws.readyState === WebSocket.OPEN) {
      send('/cancelsearch');
      for (const [room, battle] of battles) if (battle.winner === undefined) send('/forfeit', room);
      ws.close();
    }
    save(reason); console.log(reason, `Results: ${directory}/summary.json`);
    clearInterval(watchdog);
    if (failure) process.exitCode = 1;
    setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
  };
  const search = () => {
    searching = true; deadline = Date.now() + 180000;
    send(`/search ${GEN6}`); console.log(`Searching as ${name} (${results.length + 1}/${count})`);
  };
  const watchdog = setInterval(() => {
    if (Date.now() > deadline) stop(searching ? 'No opponent found within three minutes' : 'Connection or battle progress timed out', true);
  }, 1000);
  process.once('SIGINT', () => stop('Trial interrupted'));
  process.once('SIGTERM', () => stop('Trial interrupted'));
  ws.addEventListener('error', () => stop('WebSocket connection failed', true));
  ws.addEventListener('close', event => { if (!stopped) stop(`Server disconnected (${event.code})`, true); });
  // Serialize frames so authentication and room updates cannot race.
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
            const query = new URLSearchParams({act: 'getassertion', userid: userid(name), challstr: line.slice(10)});
            const response = await fetch(`https://play.pokemonshowdown.com/~~showdown/action.php?${query}`, {signal: AbortSignal.timeout(20000)});
            const assertion = (await response.text()).trim();
            if (!response.ok || !assertion || assertion.startsWith(';') || assertion.startsWith('<')) {
              const detail = assertion.startsWith(';') || assertion.startsWith('<') ? assertion.slice(0, 500) : 'Empty or failed response';
              throw new Error(`Guest authentication unavailable (HTTP ${response.status}): ${detail}`);
            }
            send(`/trn ${name},0,${assertion}`);
          }
          if (line.startsWith('|updateuser|')) {
            const [, , user, isNamed] = line.split('|');
            if (!named && isNamed === '1' && userid(user) === userid(name)) { named = true; search(); }
          }
          if (/^\|(nametaken|popup|error)\|/.test(line)) throw new Error(`Server: ${line}`);
        }
        return;
      }
      if (!room.startsWith(`battle-${GEN6}-`)) return;
      let battle = battles.get(room);
      if (!battle) {
        battle = new OnlineBattle(); battles.set(room, battle); searching = false;
        console.log(`Battle started: https://play.pokemonshowdown.com/${room}`);
        send('/timer on', room);
      }
      if (battle.winner !== undefined) return;
      const choice = battle.receive(lines, policy);
      writeFileSync(`${directory}/${room}.log`, battle.log.join('\n'));
      if (choice) {
        send(choice, room); deadline = Date.now() + 360000;
        console.log(JSON.stringify({room, receivedAt, sentAt: new Date().toISOString(), ...battle.decisions.at(-1)}));
        writeFileSync(`${directory}/${room}.decisions.json`, JSON.stringify(battle.decisions, null, 2));
      }
      for (const line of lines) {
        if (line.startsWith('|turn|')) console.log(`${room}: turn ${battle.view.turn}`);
        if (line.startsWith('|error|')) throw new Error(`Battle rejected action: ${line}`);
      }
      if (battle.winner !== undefined) {
        const result = {room, players: battle.players, winner: battle.winner, outcome: !battle.winner ? 'tie' : userid(battle.winner) === userid(name) ? 'win' : 'loss', turns: battle.view.turn, decisions: battle.decisions.length};
        results.push(result); save();
        writeFileSync(`${directory}/${room}.decisions.json`, JSON.stringify(battle.decisions, null, 2));
        console.log(JSON.stringify(result));
        if (results.length >= count) stop('Trial complete');
        else { send('/leave', room); search(); }
      }
    }).catch(error => stop(error.message, true));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
