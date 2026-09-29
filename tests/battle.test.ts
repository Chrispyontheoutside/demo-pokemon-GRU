import test from 'node:test';
import assert from 'node:assert/strict';
import { actionToChoice, isAction, legalActionsForRequest, validateAction } from '../src/battle.js';

test('action whitelist rejects extra fields and renders only simulator choices', () => {
  assert.equal(isAction({ type: 'move', slot: 1 }), true);
  assert.equal(isAction({ type: 'move', slot: 1, gimmick: 'terastallize', extra: 1 }), false);
  assert.equal(isAction({ type: 'switch', slot: 2, gimmick: 'terastallize' }), false);
  assert.equal(actionToChoice({ type: 'move', slot: 2, gimmick: 'terastallize' }), 'move 2 terastallize');
  assert.equal(actionToChoice({ type: 'switch', slot: 3 }), 'switch 3');
});

test('legal actions include Struggle fallback and omit trapped switches', () => {
  const request = {
    active: [{ moves: [{ disabled: true }], canTerastallize: false, trapped: true }],
    side: { pokemon: [
      { active: true, condition: '10/100' },
      { active: false, condition: '20/20' },
      { active: false, condition: '0 fnt' },
    ] },
  };
  const actions = legalActionsForRequest(request);
  assert.deepEqual(actions, [{ type: 'move', slot: 1 }]);
  assert.equal(validateAction({ type: 'move', slot: 1 }, actions), true);
  assert.equal(validateAction({ type: 'move', slot: 2 }, actions), false);
});

test('forced switch exposes healthy replacements and revival targets correctly', () => {
  const request = {
    forceSwitch: [true],
    side: { pokemon: [
      { active: true, reviving: false, condition: '0 fnt' },
      { active: false, condition: '20/20' },
      { active: false, condition: '0 fnt' },
    ] },
  };
  assert.deepEqual(legalActionsForRequest(request), [{ type: 'switch', slot: 2 }]);
  const revival = { ...request, side: { pokemon: [{ active: true, reviving: true, condition: '1/1' }, ...request.side.pokemon.slice(1)] } };
  assert.deepEqual(legalActionsForRequest(revival), [{ type: 'switch', slot: 3 }]);
});
