const $ = id => document.getElementById(id);
let battle = null, busy = false, viewerReady = false, viewerId = '', shownLines = 0, renderKey = '';
let currentId = sessionStorage.getItem('gen6-battle');
const node = (tag,text,className) => {const el=document.createElement(tag); if (text !== undefined) el.textContent=text; if (className) el.className=className; return el;};
async function api(path,body) {
  const response=await fetch(path,body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();
  if (!response.ok) {const error=new Error(data.error ?? 'Request failed'); error.status=response.status; throw error;}
  return data;
}
function error(message='') {$('error').textContent=message; $('error').hidden=!message;}
function syncViewer() {
  if (!viewerReady || !battle) return;
  const post=data => $('viewer').contentWindow.postMessage(data,location.origin);
  if (viewerId !== battle.id) {post({type:'load',lines:battle.lines,live:battle.status==='playing',autoplay:true}); viewerId=battle.id; shownLines=battle.lines.length;}
  else if (battle.lines.length > shownLines) {post({type:'append',lines:battle.lines.slice(shownLines)}); shownLines=battle.lines.length;}
}
function render() {
  if (!battle) return;
  const playing=battle.status==='playing';
  $('game').hidden=false; $('welcome').hidden=playing;
  $('start').textContent='Play again'; $('forfeit').disabled=!playing || busy;
  $('heading').textContent=playing ? 'Your move.' : battle.result;
  $('intro').textContent=playing ? 'Gen 6 Random Battle · You are on the left · No turn timer' : 'Try another matchup with two fresh random teams.';
  $('turn').textContent=`Turn ${battle.turn}`;
  $('status').textContent=battle.notice || (playing ? (battle.candidates?.length ? (battle.request?.forceSwitch?.some(Boolean) ? 'Choose a healthy teammate below.' : 'Choose a move, or switch to a teammate below.') : 'Resolving the turn…') : battle.result);
  $('decision-title').textContent=playing ? (battle.request?.forceSwitch?.some(Boolean) ? 'Choose a replacement' : 'Your move') : 'Battle finished';
  $('replay').href=`/api/play/${battle.id}/replay`;
  $('events').textContent=battle.lines.join('\n');
  syncViewer();
  const key=`${battle.id}:${battle.requestId}:${playing}:${battle.candidates?.length}:${busy}:${$('mega').checked}`;
  if (key===renderKey) return;
  renderKey=key;
  const candidates=battle.candidates ?? [];
  const canMega=candidates.some(c => c.index>=4 && c.index<8);
  $('mega-label').hidden=!canMega || !playing;
  const moves=candidates.filter(c => c.index<8 && (canMega && $('mega').checked ? c.index>=4 : c.index<4));
  $('moves').replaceChildren(...moves.map(c => {
    const b=node('button',undefined,'button move-button'); b.type='button'; b.disabled=busy;
    b.append(node('strong',c.label),node('small',c.detail)); b.onclick=() => act(c.index); return b;
  }));
  $('team').replaceChildren(...(battle.request?.side.pokemon ?? []).map((p,slot) => {
    const c=candidates.find(c => c.index===slot+8);
    const b=node('button',undefined,`button team-card${p.active ? ' active' : ''}`); b.type='button'; b.disabled=!c || busy || !playing;
    const name=p.details.split(',')[0];
    b.append(node('strong',`${name}${p.active ? ' · Active' : ''}`));
    const hp=p.condition.split(' ')[0].split('/').map(Number), progress=node('progress');
    progress.max=hp[1] || 1; progress.value=hp[0] || 0; progress.setAttribute('aria-label',`${name} health`);
    b.append(progress,node('small',p.condition),node('small',`${p.baseAbility || '—'} · ${p.item || 'No item'}`),node('small',p.moves.join(' · ')));
    if (c) b.onclick=() => act(c.index); return b;
  }));
}
async function act(action) {
  if (busy) return; busy=true; error(); render();
  try {battle=await api(`/api/play/${battle.id}/action`,{requestId:battle.requestId,action});}
  catch (e) {error(e.message);}
  finally {busy=false; render(); await poll();}
}
async function poll() {
  if (!currentId || busy) return;
  try {battle=await api(`/api/play/${currentId}`); render();}
  catch (e) {error(e.message); if (e.status===404) {currentId=null; sessionStorage.removeItem('gen6-battle');}}
}
$('start').onclick=async () => {
  $('start').disabled=true; error();
  try {battle=await api('/api/play',{}); currentId=battle.id; sessionStorage.setItem('gen6-battle',currentId); $('mega').checked=false; render();}
  catch (e) {error(e.message);}
  finally {$('start').disabled=false;}
};
$('forfeit').onclick=async () => {
  if (busy || !battle || !confirm('Forfeit this battle?')) return;
  busy=true; render();
  try {battle=await api(`/api/play/${battle.id}/forfeit`,{});}
  catch (e) {error(e.message);}
  finally {busy=false; render();}
};
$('mega').onchange=render;
window.addEventListener('message',event => {
  if (event.source===$('viewer').contentWindow && event.origin===location.origin && event.data?.type==='viewer-ready') {viewerReady=true; viewerId=''; syncViewer();}
});
try {
  const info=await api('/api/play');
  $('training').textContent=info.ready ? `${info.steps.toLocaleString()} reinforcement-learning decisions · ${info.games.toLocaleString()} training battles` : 'The trained checkpoint is not ready yet.';
  $('start').disabled=!info.ready;
  await poll();
} catch (e) {error(e.message);}
setInterval(poll,750);
