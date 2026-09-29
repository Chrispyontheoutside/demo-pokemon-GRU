// End-to-end check against your running localhost server; creates disposable local games.
import assert from 'node:assert/strict';
const base='http://127.0.0.1:3000';
const post=async (path,body={}) => fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const info=await (await fetch(base+'/api/play')).json();
assert.ok(info.ready && info.steps>0,'Trained checkpoint must be ready');
const start=await post('/api/play'); assert.equal(start.status,201);
let battle=await start.json();
const id=battle.id;
let decisions=0;
try {
  for (let tick=0; tick<2000 && battle.status==='playing'; tick++) {
    if (battle.candidates?.length) {
      assert.equal((await post(`/api/play/${id}/action`,{requestId:-1,action:0})).status,409);
      assert.equal((await post(`/api/play/${id}/action`,{requestId:battle.requestId,action:99})).status,409);
      const choices=battle.candidates;
      const moves=choices.filter(c=>c.index<8);
      const action=(moves.length ? moves.sort((a,b)=>Number(/(\d+) power/.exec(b.detail)?.[1]??0)-Number(/(\d+) power/.exec(a.detail)?.[1]??0)) : choices)[0];
      const result=await post(`/api/play/${id}/action`,{requestId:battle.requestId,action:action.index});
      assert.equal(result.status,200); decisions++;
    }
    await new Promise(resolve=>setTimeout(resolve,10));
    battle=await (await fetch(base+`/api/play/${id}`)).json();
  }
  assert.equal(battle.status,'finished'); assert.match(battle.result,/won|Draw/);
  const replay=await (await fetch(base+`/api/play/${id}/replay`)).text();
  assert.match(replay,/\|win\||\|tie/); assert.ok(decisions>0);
  assert.equal(battle.candidates.length,0);
  assert.equal((await post(`/api/play/${id}/action`,{requestId:battle.requestId,action:0})).status,409);
  const evil=await fetch(base+'/api/play',{headers:{Origin:'https://example.com'}});
  assert.equal(evil.status,403);
  console.log(JSON.stringify({result:battle.result,turns:battle.turn,decisions,checkpointSteps:info.steps,staleAndIllegalActions:'rejected',crossOrigin:'rejected',replay:'verified'}));
} finally {
  await post(`/api/play/${id}/forfeit`);
}
