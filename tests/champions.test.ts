import test from 'node:test';
import assert from 'node:assert/strict';
import {encode, VisibleState} from '../src/champions.js';

test('maybeTrapped active slots retain observable switch candidates', () => {
  const pokemon = [
    {details:'Pikachu, L50', condition:'100/100', active:true},
    {details:'Rotom-Heat, L50', condition:'100/100', active:true},
    {details:'Charizard, L50', condition:'100/100', active:false},
  ];
  const move = {move:'Protect', id:'protect', pp:8, maxpp:8, target:'self', disabled:false};
  const request = {active:[{moves:[move]}, {moves:[move], maybeTrapped:true}], side:{pokemon}};
  const encoded = encode(request, new VisibleState(), 'p1');
  const uncertainSwitches = encoded.candidates.filter(candidate => candidate.choice.split(', ')[1].startsWith('switch '));
  assert.ok(uncertainSwitches.length > 0);
  assert.ok(uncertainSwitches.every(candidate => candidate.features[24 + 17] === 1));
});

test('a forced switch with no living reserve emits pass', () => {
  const request = {
    forceSwitch:[true, false],
    side:{pokemon:[
      {details:'Pikachu, L50', condition:'45/100', active:true},
      {details:'Rotom-Heat, L50', condition:'0 fnt', active:true},
      {details:'Charizard, L50', condition:'0 fnt', active:false},
      {details:'Blastoise, L50', condition:'0 fnt', active:false},
    ]},
  };
  const encoded = encode(request, new VisibleState(), 'p1');
  assert.deepEqual(encoded.candidates.map(candidate => candidate.choice), ['pass, pass']);
});

test('Revival Blessing forced switch offers only fainted teammates', () => {
  const request = {
    forceSwitch:[false, true],
    side:{pokemon:[
      {details:'Oranguru, L50, M', condition:'45/167', active:true},
      {details:'Pawmot, L50, M', condition:'68/147', active:true, reviving:true},
      {details:'Altaria, L50, M', condition:'152/152', active:false},
      {details:'Rhyperior, L50, M', condition:'0 fnt', active:false},
    ]},
    noCancel:true,
  };
  const encoded = encode(request, new VisibleState(), 'p1');
  assert.deepEqual(encoded.candidates.map(candidate => candidate.choice), ['pass, switch 4']);
});

test('an ordinary forced switch still offers only living teammates', () => {
  const request = {
    forceSwitch:[false, true],
    side:{pokemon:[
      {details:'Oranguru, L50, M', condition:'45/167', active:true},
      {details:'Pawmot, L50, M', condition:'0 fnt', active:true},
      {details:'Altaria, L50, M', condition:'152/152', active:false},
      {details:'Rhyperior, L50, M', condition:'0 fnt', active:false},
    ]},
  };
  const encoded = encode(request, new VisibleState(), 'p1');
  assert.deepEqual(encoded.candidates.map(candidate => candidate.choice), ['pass, switch 3']);
});

test('Revival Blessing can revive a fainted ally that still occupies an active slot', () => {
  const request = {
    forceSwitch:[false, true],
    side:{pokemon:[
      {details:'Oranguru, L50, M', condition:'0 fnt', active:true},
      {details:'Pawmot, L50, M', condition:'68/147', active:true, reviving:true},
      {details:'Altaria, L50, M', condition:'152/152', active:false},
    ]},
    noCancel:true,
  };
  const encoded = encode(request, new VisibleState(), 'p1');
  assert.deepEqual(encoded.candidates.map(candidate => candidate.choice), ['pass, switch 1']);
});
