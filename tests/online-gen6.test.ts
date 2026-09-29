import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Policy} from '../src/gen6.js';
import {OnlineBattle} from '../src/online-gen6.js';

test('online adapter processes full frames, deduplicates requests, respects wait and terminal states', () => {
  const policy = new Policy(JSON.parse(readFileSync('models/gen6-policy.json', 'utf8')));
  const battle = new OnlineBattle();
  const request = {rqid: 4, side: {id: 'p2', pokemon: [
    {ident: 'p2: Pikachu', details: 'Pikachu, L88', condition: '100/100', active: true, stats: {spa: 100}, moves: ['thunderbolt'], baseAbility: 'static', item: ''},
  ]}, active: [{moves: [{id: 'thunderbolt', move: 'Thunderbolt', pp: 15, maxpp: 15}], trapped: true}]};
  const line = `|request|${JSON.stringify(request)}`;
  assert.equal(battle.receive([line, '|switch|p1a: Blastoise|Blastoise, L80|100/100', '|switch|p2a: Pikachu|Pikachu, L88|100/100', '|turn|3'], policy, () => 0), '/choose move 1|4');
  assert.equal(battle.decisions[0].turn, 3);
  assert.equal(battle.receive([line], policy), undefined);
  assert.equal(battle.receive(['|request|{"wait":true,"rqid":5}'], policy), undefined);
  const forced = {rqid: 6, forceSwitch: [true], side: {id: 'p2', pokemon: [
    {...request.side.pokemon[0], condition: '0 fnt'},
    {...request.side.pokemon[0], ident: 'p2: Raichu', details: 'Raichu, L88', active: false},
  ]}};
  assert.equal(battle.receive([`|request|${JSON.stringify(forced)}`, '|faint|p2a: Pikachu'], policy), '/choose switch 2|6');
  assert.equal(battle.receive(['|player|p1|Opponent|1|1100', '|player|p1|', line, '|win|Opponent'], policy), undefined);
  assert.equal(battle.players.p1, 'Opponent');
  assert.equal(battle.decisions.length, 2);
});
