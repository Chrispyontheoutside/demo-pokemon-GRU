import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {VisibleState} from '../dist/src/champions.js';
import {humanContextFeatures, HUMAN_CONTEXT_NAMES, HUMAN_KINDS} from '../dist/src/human-context.js';

const [rawPath, roomsPath, setupPath, output] = process.argv.slice(2);
if (!output) throw new Error('Usage: build-human-context raw.json train-rooms.json setup-moves.json output.json');
const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
const allowed = new Set(JSON.parse(readFileSync(roomsPath, 'utf8')));
const setup = new Set(JSON.parse(readFileSync(setupPath, 'utf8')));
const guards = new Set(['Protect','Detect',"King's Shield",'Spiky Shield','Baneful Bunker','Obstruct','Silk Trap','Burning Bulwark','Wide Guard','Quick Guard']);
const userid = name => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const rows = [];
const rooms = [];
for (const record of raw) {
  if (!allowed.has(record.room)) continue;
  const path = resolve('runs/champions-vgc-2026-reg-mc/ladder', record.observedAt, `${record.room}.log`);
  const lines = readFileSync(path, 'utf8').split('\n');
  const players = Object.fromEntries(lines.map(l => l.split('|')).filter(p => p[1] === 'player').map(p => [p[2], p[3]]));
  const me = Object.keys(players).find(side => userid(players[side]) === userid(record.account));
  if (!me) throw new Error(`Our account not present in ${record.room}`);
  const side = me === 'p1' ? 'p2' : 'p1';
  const view = new VisibleState();
  let decisionView;
  let acted = new Set(), fainted = new Set(), forced = new Set();
  rooms.push(record.room);
  for (const line of lines) {
    const p = line.split('|'), command = p[1], ident = p[2] ?? '', slot = ident.slice(0, 3);
    if (command === 'turn') {
      view.receive(line); decisionView = view.clone(); acted = new Set(); fainted = new Set(); forced = new Set(); continue;
    }
    if (command === 'faint') fainted.add(slot);
    if (command === '-enditem' && ['Eject Button','Eject Pack'].includes(p[3])) forced.add(slot);
    if (command === '-ability' && ['Emergency Exit','Wimp Out'].includes(p[3])) forced.add(slot);
    if (decisionView && ident.startsWith(side) && !acted.has(slot)) {
      let kind;
      if (command === 'switch' && !fainted.has(slot) && !forced.has(slot)) kind = 'switch';
      if (command === 'move') kind = guards.has(p[3]) ? 'protect' : p[3] === 'Fake Out' ? 'fakeout' : setup.has(p[3]) ? 'setup' : 'move';
      if (kind) {
        const features = humanContextFeatures(decisionView, side, slot.endsWith('b') ? 1 : 0);
        const fraction = features[HUMAN_CONTEXT_NAMES.indexOf('hp')];
        const turn = decisionView.turn;
        rows.push({room: record.room, turn, slot, label: HUMAN_KINDS.indexOf(kind),
          bucket: `${turn <= 1 ? 0 : turn <= 3 ? 1 : 2}:${fraction < .35 ? 0 : fraction < .7 ? 1 : 2}`, features});
        acted.add(slot);
      }
    }
    view.receive(line);
  }
}
writeFileSync(output, JSON.stringify({rooms, features: HUMAN_CONTEXT_NAMES, kinds: HUMAN_KINDS, rows}));
console.log(JSON.stringify({rooms: rooms.length, rows: rows.length, dimensions: HUMAN_CONTEXT_NAMES.length}));
