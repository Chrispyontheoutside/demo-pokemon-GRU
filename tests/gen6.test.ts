import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {VisibleState, encode, legalChoices, Policy, playGen6, heuristic, type Gen6Request} from '../src/gen6.js';
import {HumanBattle} from '../src/play.js';

function request(): Gen6Request {
  return {side:{pokemon:[
    {ident:'p1: Charizard',details:'Charizard, L80',condition:'200/300',active:true,stats:{atk:180,spa:220,spe:200},moves:['flamethrower','roost'],baseAbility:'blaze',item:'charizarditex'},
    {ident:'p1: Pikachu',details:'Pikachu, L88',condition:'100/100',active:false,stats:{atk:100},moves:['thunderbolt'],baseAbility:'static',item:'lightball'},
    {ident:'p1: Snorlax',details:'Snorlax, L80',condition:'0 fnt',active:false,stats:{atk:100},moves:['rest'],baseAbility:'thickfat',item:'leftovers'},
  ]},active:[{moves:[{id:'flamethrower',move:'Flamethrower',pp:10,maxpp:15},{id:'roost',move:'Roost',pp:0,maxpp:10,disabled:true}],canMegaEvo:true}]};
}
function view() {
  const v=new VisibleState();
  v.receive('|switch|p1a: Charizard|Charizard, L80|200/300');
  v.receive('|switch|p2a: Ferrothorn|Ferrothorn, L80|100/100');
  return v;
}
test('Gen 6 masks normal/Mega moves, trapped switches, forced replacements and Struggle', () => {
  const r=request();
  assert.deepEqual(legalChoices(r).map(c=>c.choice),['move 1','move 1 mega','switch 2']);
  r.active![0].trapped=true;
  assert.deepEqual(legalChoices(r).map(c=>c.choice),['move 1','move 1 mega']);
  r.forceSwitch=[true];
  assert.deepEqual(legalChoices(r).map(c=>c.choice),['switch 2']);
  delete r.forceSwitch;
  r.active![0]={moves:[{id:'struggle',move:'Struggle'}],trapped:true};
  assert.deepEqual(legalChoices(r).map(c=>c.choice),['move 1']);
  assert.deepEqual(legalChoices({...r,wait:true}),[]);
});
test('encoder keeps unknown opponents distinct and handles mandatory Recharge without NaN', () => {
  const r=request(),v=view(), e=encode(v,r,'p1');
  assert.equal(e.state.length,426); assert.equal(e.actions.length,14);
  assert.ok(e.state.every(Number.isFinite));
  assert.equal(v.teams.p2.size,1);
  const poisoned={...r,hiddenOpponentTeam:[{species:'Mewtwo',item:'Life Orb',hp:123}]};
  assert.deepEqual(encode(v,poisoned,'p1'),e);
  v.receive('|faint|p2a: Ferrothorn');
  assert.notDeepEqual(encode(v,r,'p1').state,e.state);
  r.active![0]={moves:[{id:'recharge',move:'Recharge'}],trapped:true};
  const recharge=encode(v,r,'p1');
  assert.equal(recharge.candidates[0].label,'Recharge');
  assert.ok(recharge.actions.flat().every(Number.isFinite));
});
test('visible boosts, field effects, revealed abilities and forms update', () => {
  const v=view();
  v.receive('|-boost|p1a: Charizard|spa|2'); v.receive('|-sidestart|p1: You|move: Stealth Rock');
  v.receive('|-weather|RainDance'); v.receive('|-fieldstart|move: Trick Room');
  v.receive('|-ability|p2a: Ferrothorn|Levitate');
  assert.equal(v.active.p1?.boosts.spa,2); assert.ok(v.field.p1.has('stealthrock'));
  assert.equal(v.weather,'raindance'); assert.ok(v.trickRoom); assert.equal(v.active.p2?.ability,'levitate');
  v.receive('|detailschange|p1a: Charizard|Charizard-Mega-X, L80');
  assert.deepEqual(v.active.p1?.types,['Fire','Dragon']);
  v.receive('|-clearallboost'); assert.deepEqual(v.active.p1?.boosts,{});
});
test('local games reproduce seeded player-visible traces and report caps separately', async () => {
  const run=async () => {
    const lines:string[]=[];
    const result=await playGen6({seed:333,p1:heuristic,p2:heuristic,onLine:line=>{if (!line.startsWith('|t:|')) lines.push(line);}});
    return {result,lines};
  };
  assert.deepEqual(await run(),await run());
  const capped=await playGen6({seed:333,p1:heuristic,p2:heuristic,maxTurns:2});
  assert.equal(capped.truncated,true);
});
test('trained export rejects incompatible tensors and masks illegal actions', () => {
  const checkpoint=JSON.parse(readFileSync(resolve('models/gen6-policy.json'),'utf8'));
  assert.ok(checkpoint.steps>0);
  const model=new Policy(checkpoint),encoded=encode(view(),request(),'p1');
  const prediction=model.predict(encoded);
  assert.ok(Number.isFinite(prediction.value));
  assert.ok(Math.abs(prediction.probabilities.reduce((a,b)=>a+b)-1)<1e-6);
  prediction.probabilities.forEach((p,i)=>{if (!encoded.mask[i]) assert.equal(p,0);});
  assert.throws(()=>new Policy({...checkpoint,schema:999}));
});
test('a turn cap terminates even with human input pending', {timeout:2000}, async () => {
  const result=await playGen6({seed:333,maxTurns:1,p1:()=>new Promise<number>(()=>{}),p2:heuristic});
  assert.equal(result.truncated,true);
});
test('a human-controlled game reaches a natural result against the trained learner', async () => {
  const battle=new HumanBattle(resolve('models/gen6-policy.json'));
  let decisions=0;
  while (battle.status==='playing') {
    if (battle.encoded && battle.snapshot().candidates?.length) {
      const revision=battle.revision;
      assert.throws(()=>battle.choose(revision-1,0),/turn has changed/);
      assert.throws(()=>battle.choose(revision,99),/available/);
      battle.choose(revision,heuristic(battle.encoded)); decisions++;
    }
    await setImmediate();
    assert.ok(decisions<1000);
  }
  await battle.done;
  assert.equal(battle.status,'finished');
  assert.match(battle.result,/won|Draw/);
  assert.ok(decisions>0);
  assert.ok(battle.lines.some(line=>line.startsWith('|win|') || line.startsWith('|tie')));
});
test('forfeit cancels a pending human turn without leaving a battle running', async () => {
  const battle=new HumanBattle(resolve('models/gen6-policy.json'));
  await setImmediate(); battle.forfeit(); await battle.done;
  assert.equal(battle.status,'finished'); assert.match(battle.result,/forfeited/);
  assert.equal(battle.snapshot().candidates?.length,0);
});
