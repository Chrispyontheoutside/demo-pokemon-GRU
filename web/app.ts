import type {
  Action, AgentView, ArenaState, Evaluation, LeaderboardEntry, MatchDetail,
  MatchRecord, MatchSummary, Mode, Observation, Side, StoredRecord,
} from '../src/contracts.js';

type Route = { name: 'arena' | 'history' | 'leaderboard' | 'match'; id?: string };
type MatchSession = {
  id: string; detail: MatchDetail | null; lines: string[]; viewerReady: boolean;
  selectedTurn: number; selectedSide: Side | 'all'; root: HTMLElement; frame: HTMLIFrameElement; seen: Set<number>;
};

const app = document.querySelector<HTMLDivElement>('#app')!;
let state: ArenaState | null = null;
let route: Route = { name: 'arena' };
let session: MatchSession | null = null;
let stream: EventSource | null = null;
let connected = false;
let errorMessage = '';

const $ = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, ...children: Array<string | Node | undefined>) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  for (const child of children) if (child !== undefined) el.append(child);
  return el;
};

function attrs<T extends HTMLElement>(el: T, values: Record<string, string | boolean | undefined>): T {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === false) continue;
    if (key === 'className') el.className = String(value);
    else if (key === 'disabled' && value) el.setAttribute('disabled', '');
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  return el;
}

function button(label: string, onClick: (event: MouseEvent) => void, className = 'button') {
  const el = attrs($('button', className, label), { type: 'button' });
  el.addEventListener('click', onClick);
  return el;
}

function link(label: string, href: string, className = '') {
  return attrs($('a', className, label), { href });
}

function text(value: unknown, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function date(value: string | null) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function duration(start: string, end: string | null) {
  if (!end) return 'Live';
  const ms = Math.max(0, new Date(end).valueOf() - new Date(start).valueOf());
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round(ms / 1000) % 60}s`;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : name.slice(0, 2)).toUpperCase();
}

function statusClass(value: string) { return `status status-${value}`; }
function statusLabel(value: string) { return value[0].toUpperCase() + value.slice(1); }
function modeLabel(mode: Mode) { return mode === 'ranked' ? 'Ranked' : 'Unranked'; }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  let body: unknown = null;
  try { body = await response.json(); } catch { /* text endpoints are handled by anchors */ }
  if (!response.ok) {
    const message = typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

function jsonBody(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };
}

function captureFormState() {
  const values = new Map<string, string>();
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-preserve]').forEach((field) => {
    if (field.id) values.set(field.id, field.value);
  });
  const active = document.activeElement as HTMLElement | null;
  return { values, focusId: active?.id ?? '', selectionStart: (active as HTMLInputElement)?.selectionStart ?? null };
}

function restoreFormState(snapshot: ReturnType<typeof captureFormState>) {
  for (const [id, value] of snapshot.values) {
    const field = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (field) field.value = value;
  }
  if (snapshot.focusId) {
    const active = document.getElementById(snapshot.focusId) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (active) { active.focus({ preventScroll: true }); if (snapshot.selectionStart !== null && 'setSelectionRange' in active) active.setSelectionRange(snapshot.selectionStart, snapshot.selectionStart); }
  }
}

function shell() {
  app.replaceChildren();
  const header = $('header', 'topbar');
  const inner = $('div', 'topbar-inner');
  inner.append(link('SHOWDOWN ARENA', '#arena', 'brand'));
  const nav = $('nav', 'nav', undefined);
  for (const item of [['Play Gen 6', '/play.html', 'play'], ['Arena', '#arena', 'arena'], ['History', '#history', 'history'], ['Leaderboard', '#leaderboard', 'leaderboard']] as const) {
    const a = link(item[0], item[1], 'nav-link'); a.dataset.route = item[2]; nav.append(a);
  }
  const live = $('div', 'connection');
  live.id = 'connection';
  live.append($('span', 'connection-dot'), $('span', 'connection-label', 'Connecting'));
  inner.append(nav, live); header.append(inner);
  const main = $('main'); main.id = 'main';
  app.append(header, main);
}

function updateConnection() {
  const el = document.querySelector('#connection');
  if (!el) return;
  el.classList.toggle('is-online', connected);
  const label = el.querySelector('.connection-label'); if (label) label.textContent = connected ? 'Live' : 'Reconnecting';
}

function updateNav() {
  document.querySelectorAll<HTMLElement>('.nav-link').forEach((el) => el.classList.toggle('active', el.dataset.route === route.name));
}

function pageHeading(eyebrow: string, title: string, detail: string) {
  const heading = $('div', 'page-heading');
  heading.append($('p', 'eyebrow', eyebrow), $('h1', undefined, title), $('p', 'lede', detail));
  return heading;
}

function card(className = 'panel') { return $('section', className); }

function agentChip(agent: { name: string; version?: string }, side?: Side) {
  const chip = $('div', 'agent-chip');
  chip.append($('span', `avatar ${side ?? ''}`, initials(agent.name)), $('span', undefined, agent.name));
  if (side) chip.append($('span', 'side-label', side.toUpperCase()));
  return chip;
}

function resultFor(match: MatchSummary, side: Side) {
  if (match.status !== 'completed') return match.status === 'running' ? 'In progress' : 'Interrupted';
  if (!match.winner) return 'Draw';
  return match.winner === side ? 'Win' : 'Loss';
}

function matchRow(match: MatchSummary) {
  const tr = $('tr');
  const duel = $('div', 'table-duel'); duel.append(agentChip(match.p1, 'p1'), $('span', 'versus', 'vs'), agentChip(match.p2, 'p2'));
  const duelCell = $('td'); duelCell.append(duel);
  const mode = $('td'); mode.append($('span', 'mode-pill', modeLabel(match.mode)));
  const outcome = $('td');
  const outcomeText = match.winner ? `${match.winner === 'p1' ? match.p1.name : match.p2.name} won` : (match.reason ?? statusLabel(match.status));
  outcome.append($('span', statusClass(match.status), statusLabel(match.status)), $('span', 'table-subtext', outcomeText));
  const meta = $('td'); meta.append($('span', undefined, date(match.startedAt)), $('span', 'table-subtext', `Turn ${match.turn} · ${duration(match.startedAt, match.endedAt)}`));
  tr.append(duelCell, mode, outcome, meta);
  tr.addEventListener('click', () => { window.location.hash = `#match/${encodeURIComponent(match.id)}`; });
  tr.tabIndex = 0; tr.setAttribute('role', 'link'); tr.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); tr.click(); } });
  return tr;
}

function matchTable(matches: MatchSummary[], empty = 'No matches yet. Queue two agents to create the first battle.') {
  if (!matches.length) return $('div', 'empty-state', empty);
  const table = $('table', 'data-table');
  const head = $('thead'); const row = $('tr'); ['Match', 'Mode', 'Outcome', 'Started'].forEach((label) => row.append($('th', undefined, label))); head.append(row);
  const body = $('tbody'); matches.forEach((match) => body.append(matchRow(match))); table.append(head, body);
  const wrap = $('div', 'table-wrap'); wrap.append(table); return wrap;
}

function arena() {
  const main = document.querySelector('main')!;
  if (!state) { main.replaceChildren(pageHeading('Arena', 'Loading the board', 'Connecting to the local battle service…')); return; }
  const heading = pageHeading('Live arena', 'A proving ground for your agents.', 'Gen 9 Random Battles · Local agent arena');
  const active = card('panel hero-panel');
  const activeTop = $('div', 'panel-heading'); activeTop.append($('div', undefined, $('p', 'eyebrow', 'Active battle'), $('h2', undefined, state.activeMatch ? `${state.activeMatch.p1.name} vs ${state.activeMatch.p2.name}` : 'The arena is quiet')));
  if (state.activeMatch) activeTop.append($('span', 'live-badge', '● LIVE'));
  active.append(activeTop);
  if (state.activeMatch) {
    const match = state.activeMatch; const battle = $('div', 'hero-battle');
    const left = $('div', 'hero-agent'); left.append($('span', 'avatar large p1', initials(match.p1.name)), $('strong', undefined, match.p1.name), $('span', 'muted', 'P1'));
    const center = $('div', 'hero-center'); center.append($('span', 'vs-large', 'VS'), $('span', 'muted', `Turn ${match.turn} · ${modeLabel(match.mode)}`), link('Open battle →', `#match/${encodeURIComponent(match.id)}`, 'text-link'));
    const right = $('div', 'hero-agent right'); right.append($('span', 'avatar large p2', initials(match.p2.name)), $('strong', undefined, match.p2.name), $('span', 'muted', 'P2'));
    battle.append(left, center, right); active.append(battle);
  } else {
    const empty = $('div', 'hero-empty'); empty.append($('span', 'empty-orbit', '✦'), $('div', undefined, $('strong', undefined, 'No match is running'), $('p', 'muted', 'Queue an agent below, then pair it with an opponent to start a battle.'))); active.append(empty);
  }
  const grid = $('div', 'arena-grid');
  const agents = card('panel agents-panel');
  const agentsHeader = $('div', 'panel-heading'); agentsHeader.append($('div', undefined, $('p', 'eyebrow', 'Registered agents'), $('h2', undefined, `${state.agents.length} ready to play`))); agents.append(agentsHeader);
  const agentList = $('div', 'agent-list');
  state.agents.forEach((agent) => {
    const item = $('article', 'agent-card');
    const top = $('div', 'agent-card-top'); top.append($('div', 'agent-identity', $('span', 'avatar', initials(agent.name))), $('div', undefined, $('h3', undefined, agent.name), $('span', 'muted', `v${agent.version} · ${agent.modelName ?? 'Local policy'}`)));
    const stateLabel = agent.state === 'running' ? 'Running' : agent.state === 'queued' ? 'Queued' : 'Ready'; top.append($('span', statusClass(agent.state === 'idle' ? 'completed' : agent.state), stateLabel)); item.append(top);
    if (agent.description) item.append($('p', 'agent-description', agent.description));
    const actions = $('form', 'queue-form'); actions.id = `queue-${agent.id}`;
    const mode = attrs($('select', 'select-control'), { id: `queue-mode-${agent.id}`, name: 'mode', 'aria-label': `Queue mode for ${agent.name}`, 'data-preserve': 'true' }) as HTMLSelectElement;
    for (const value of ['ranked', 'unranked'] as Mode[]) { const option = $('option', undefined, modeLabel(value)); option.value = value; mode.append(option); }
    const queued = state!.queue.find((entry) => entry.agentId === agent.id);
    if (queued) { mode.value = queued.mode; mode.disabled = true; actions.append(mode, button('Leave queue', () => removeQueue(agent.id), 'button button-quiet')); }
    else { const queue = button(agent.state === 'running' ? 'Playing' : agent.state === 'queued' ? 'Reserved' : 'Queue agent', () => queueAgent(agent.id, mode.value as Mode), 'button button-primary'); queue.disabled = agent.state !== 'idle'; mode.disabled = agent.state !== 'idle'; actions.append(mode, queue); }
    actions.addEventListener('submit', (event) => event.preventDefault()); item.append(actions); agentList.append(item);
  });
  agents.append(agentList); grid.append(agents);

  const pairing = card('panel pairing-panel');
  const pairHead = $('div', 'panel-heading'); pairHead.append($('div', undefined, $('p', 'eyebrow', 'Evaluation lab'), $('h2', undefined, 'Pair an evaluation'))); pairing.append(pairHead, $('p', 'muted', 'Run two unranked games with swapped sides and the same seed.'));
  const pairForm = $('form', 'pair-form');
  const p1 = pairSelect('p1', 'First agent', state.agents); const p2 = pairSelect('p2', 'Second agent', state.agents); pairForm.append(p1.wrap, $('span', 'pair-mark', '×'), p2.wrap);
  const pairButton = button('Start evaluation', () => startEvaluation(p1.select.value, p2.select.value), 'button button-primary'); pairButton.disabled = state.agents.filter(a => a.state === 'idle').length < 2; pairForm.append(pairButton); pairForm.addEventListener('submit', (event) => event.preventDefault()); pairing.append(pairForm);
  if (state.evaluations.length) {
    const evals = $('div', 'evaluation-list');
    for (const evaluation of state.evaluations.slice(0, 3)) {
      const a = state.agents.find(agent => agent.id === evaluation.p1Id)?.name ?? evaluation.p1Id;
      const b = state.agents.find(agent => agent.id === evaluation.p2Id)?.name ?? evaluation.p2Id;
      const games = evaluation.matchIds.map(id => state!.matches.find(m => m.id === id)).filter((m): m is MatchSummary => !!m);
      const wins = (agentId: string) => games.filter(m => m.winner && m[m.winner].id === agentId).length;
      const row = $('div', 'evaluation-entry');
      row.append($('div', 'evaluation-row', $('strong', undefined, `${a} × ${b}`), $('span', statusClass(evaluation.status), statusLabel(evaluation.status))));
      row.append($('p', 'muted', `${wins(evaluation.p1Id)} – ${wins(evaluation.p2Id)} · ${games.filter(m => m.status === 'completed').length}/2 games complete`));
      for (const [i, game] of games.entries()) row.append(link(`Game ${i + 1} →`, `#match/${game.id}`, 'text-link evaluation-link'));
      evals.append(row);
    }
    pairing.append(evals);
  }

  grid.append(pairing); main.replaceChildren(heading, active, grid);
  if (state.matches.length) {
    const recent = card('panel table-panel recent-panel');
    recent.append($('div', 'panel-heading', $('h2', undefined, 'Recent battles'), link('All history →', '#history', 'text-link')), matchTable(state.matches.slice(0, 5)));
    main.append(recent);
  }
  if (errorMessage) main.prepend(errorBanner());
}

function pairSelect(name: string, label: string, agents: AgentView[]) {
  const wrap = $('label', 'field'); wrap.append($('span', 'field-label', label));
  const select = attrs($('select', 'select-control'), { id: `pair-${name}`, name, 'data-preserve': 'true' }) as HTMLSelectElement;
  agents.forEach((agent) => { const option = $('option', undefined, agent.name); option.value = agent.id; select.append(option); }); if (name === 'p2' && agents.length > 1) select.selectedIndex = 1; wrap.append(select); return { wrap, select };
}

function errorBanner() { const el = $('div', 'error-banner', errorMessage); el.setAttribute('role', 'alert'); el.append(button('Dismiss', () => { errorMessage = ''; el.remove(); }, 'button button-quiet')); return el; }

async function queueAgent(agentId: string, mode: Mode) {
  const previous = state?.matches[0]?.id;
  await mutate('/api/queue', jsonBody({ agentId, mode }));
  const latest = state?.matches[0];
  if (latest && latest.id !== previous && (latest.p1.id === agentId || latest.p2.id === agentId)) location.hash = `#match/${latest.id}`;
}
async function removeQueue(agentId: string) { await mutate(`/api/queue/${encodeURIComponent(agentId)}`, { method: 'DELETE' }); }
async function startEvaluation(p1Id: string, p2Id: string) {
  if (!p1Id || !p2Id || p1Id === p2Id) { errorMessage = 'Choose two different agents for an evaluation.'; updatePage(); return; }
  try {
    const evaluation = await request<{ id: string }>('/api/evaluations', jsonBody({ p1Id, p2Id }));
    state = await request<ArenaState>('/api/state'); errorMessage = ''; updatePage(true);
    const match = state.matches.find(m => m.groupId === evaluation.id);
    if (match) location.hash = `#match/${match.id}`;
  } catch (error) { errorMessage = error instanceof Error ? error.message : 'Could not start evaluation.'; updatePage(true); }
}
async function mutate(url: string, init: RequestInit) {
  try { await request<unknown>(url, init); state = await request<ArenaState>('/api/state'); errorMessage = ''; updatePage(true); } catch (error) { errorMessage = error instanceof Error ? error.message : 'The request failed.'; updatePage(true); }
}

function history() {
  const main = document.querySelector('main')!; if (!state) { main.replaceChildren(pageHeading('History', 'Loading matches', 'Fetching the recorded battles…')); return; }
  const heading = pageHeading('Archive', 'Every battle leaves a trace.', 'Replay completed games and inspect the public record.');
  const controls = card('panel filters');
  const mode = filterSelect('history-mode', 'Mode', [['all', 'All modes'], ['ranked', 'Ranked'], ['unranked', 'Unranked']]);
  const agent = filterSelect('history-agent', 'Agent', [['all', 'All agents'], ...state.agents.map((a) => [a.id, a.name])]);
  const status = filterSelect('history-status', 'Status', [['all', 'All statuses'], ['completed', 'Completed'], ['running', 'Running'], ['interrupted', 'Interrupted']]);
  [mode, agent, status].forEach((field) => field.select.addEventListener('change', () => updatePage(true))); controls.append(mode.wrap, agent.wrap, status.wrap);
  const values = { mode: mode.select.value, agent: agent.select.value, status: status.select.value };
  const matches = state.matches.filter((m) => (values.mode === 'all' || m.mode === values.mode) && (values.agent === 'all' || m.p1.id === values.agent || m.p2.id === values.agent) && (values.status === 'all' || m.status === values.status));
  const result = card('panel table-panel'); result.append($('div', 'table-toolbar', $('strong', undefined, `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`)), matchTable(matches)); main.replaceChildren(heading, controls, result); if (errorMessage) main.prepend(errorBanner());
}

function filterSelect(id: string, label: string, options: string[][]) {
  const previous = (document.getElementById(id) as HTMLSelectElement | null)?.value;
  const wrap = $('label', 'filter-field'); wrap.append($('span', 'field-label', label)); const select = attrs($('select', 'select-control'), { id, 'data-preserve': 'true' }) as HTMLSelectElement;
  options.forEach(([value, labelText]) => { const option = $('option', undefined, labelText); option.value = value; select.append(option); }); if (previous && options.some(([value]) => value === previous)) select.value = previous; wrap.append(select); return { wrap, select };
}

function leaderboard() {
  const main = document.querySelector('main')!; if (!state) { main.replaceChildren(pageHeading('Leaderboard', 'Loading rankings', 'Fetching rating history…')); return; }
  const heading = pageHeading('Standings', 'Let the results speak.', 'Ranked games update Elo after a completed result.');
  const rows = state.leaderboard;
  const panel = card('panel table-panel leaderboard-panel');
  if (!rows.length) panel.append($('div', 'empty-state', 'No ranked results yet. Start a ranked queue to establish the first rating.'));
  else {
    const table = $('table', 'data-table leaderboard-table'); const thead = $('thead'); const h = $('tr'); ['#', 'Agent', 'Rating', 'Record', 'Median latency'].forEach((label) => h.append($('th', undefined, label))); thead.append(h); const body = $('tbody');
    rows.forEach((entry, index) => { const tr = $('tr'); tr.append($('td', 'rank-number', String(index + 1))); const name = $('td'); name.append(agentChip(entry), $('span', 'table-subtext', `v${entry.version}`)); const rating = $('td', 'rating', String(Math.round(entry.rating))); const record = $('td', undefined, `${entry.wins}–${entry.losses}–${entry.draws}`); const latency = $('td', 'latency', entry.medianLatencyMs === null ? '—' : `${Math.round(entry.medianLatencyMs)} ms`); tr.append(name, rating, record, latency); body.append(tr); }); table.append(thead, body); const wrap = $('div', 'table-wrap'); wrap.append(table); panel.append(wrap);
  }
  main.replaceChildren(heading, panel); if (errorMessage) main.prepend(errorBanner());
}

function matchHeader(detail: MatchDetail) {
  const match = detail.match; const header = $('div', 'match-header');
  const back = link('← Back to history', '#history', 'back-link'); header.append(back, $('p', 'eyebrow', `${modeLabel(match.mode)} · ${match.formatId}`));
  const title = $('div', 'match-title'); title.append($('h1', undefined, `${match.p1.name} vs ${match.p2.name}`), $('span', statusClass(match.status), statusLabel(match.status))); header.append(title);
  const metadata = $('div', 'match-meta'); metadata.append($('span', undefined, `Turn ${match.turn}`), $('span', undefined, date(match.startedAt)), $('span', undefined, duration(match.startedAt, match.endedAt))); if (match.reason) metadata.append($('span', 'reason', match.reason)); header.append(metadata); return header;
}

function matchPage(detail: MatchDetail) {
  const main = document.querySelector('main')!; const publicLines = detail.records.filter((record) => record.kind === 'public').map((record) => typeof record.data === 'string' ? record.data : '');
  const frame = $('iframe', 'viewer-frame') as HTMLIFrameElement; attrs(frame, { title: 'Showdown battle viewer', src: '/viewer.html', loading: 'eager' });
  session = { id: detail.match.id, detail, lines: publicLines, viewerReady: false, selectedTurn: detail.match.turn || 1, selectedSide: 'all', root: main, frame, seen: new Set(detail.records.map(r => r.seq)) };
  const layout = $('div', 'match-layout'); const viewer = card('panel viewer-panel'); const viewerTop = $('div', 'panel-heading'); viewerTop.append($('div', undefined, $('p', 'eyebrow', 'Spectator feed'), $('h2', undefined, 'Battle view')), $('span', 'viewer-note', detail.match.status === 'running' ? 'Live' : 'Replay')); viewer.append(viewerTop, frame);
  const side = $('aside', 'match-sidebar'); const actions = card('panel match-actions'); actions.append($('p', 'eyebrow', 'Controls'), link('Download replay', `/api/matches/${encodeURIComponent(detail.match.id)}/replay`, 'button button-secondary'));
  const audit = link(detail.auditAvailable ? 'Download full audit' : 'Audit locked until evaluation completes', detail.auditAvailable ? `/api/matches/${encodeURIComponent(detail.match.id)}/audit` : '#', `button ${detail.auditAvailable ? 'button-secondary' : 'button-disabled'}`); if (!detail.auditAvailable) { audit.setAttribute('aria-disabled', 'true'); audit.addEventListener('click', (event) => event.preventDefault()); } actions.append(audit);
  if (detail.match.status === 'running') actions.append(button('Cancel match', () => cancelMatch(detail.match.id), 'button button-danger')); side.append(actions);
  const summary = card('panel summary-panel'); summary.id = 'match-summary'; renderSummary(summary, detail); side.append(summary); layout.append(viewer, side);
  const logs = card('panel logs-panel'); logs.append($('div', 'panel-heading', $('div', undefined, $('p', 'eyebrow', 'Public log'), $('h2', undefined, 'Battle events')))); const pre = $('pre', 'log-output'); pre.id = 'public-log'; pre.textContent = publicLines.join('\n'); logs.append(pre);
  const inspector = card('panel inspector-panel'); inspector.id = 'inspector'; renderInspector(inspector, session); main.replaceChildren(matchHeader(detail), layout, logs, inspector); if (errorMessage) main.prepend(errorBanner());
}

function renderSummary(root: HTMLElement, detail: MatchDetail) {
  root.replaceChildren($('div', 'panel-heading', $('div', undefined, $('p', 'eyebrow', 'Result'), $('h2', undefined, detail.match.status === 'running' ? 'Battle in progress' : detail.match.winner ? `${detail.match.winner === 'p1' ? detail.match.p1.name : detail.match.p2.name} won` : statusLabel(detail.match.status)))));
  const grid = $('div', 'summary-grid'); [['Format', detail.match.formatId], ['Engine', detail.match.engineVersion], ['Status', statusLabel(detail.match.status)], ['Reason', detail.match.reason ?? '—']].forEach(([label, value]) => { const item = $('div'); item.append($('span', 'field-label', label), $('strong', undefined, value)); grid.append(item); }); root.append(grid);
}

function sendViewerLoad() {
  if (!session || !session.frame.contentWindow) return; session.viewerReady = true; session.frame.contentWindow.postMessage({ type: 'load', lines: session.lines, live: session.detail?.match.status === 'running' }, location.origin);
}

function appendMatchLine(record: StoredRecord) {
  if (!session || session.id !== record.matchId || record.kind !== 'public' || typeof record.data !== 'string') return;
  if (session.seen.has(record.seq)) return;
  session.seen.add(record.seq);
  session.detail?.records.push(record);
  session.lines.push(record.data); const log = document.querySelector<HTMLPreElement>('#public-log'); if (log) log.textContent = session.lines.join('\n');
  if (session.viewerReady && session.frame.contentWindow) session.frame.contentWindow.postMessage({ type: 'append', lines: [record.data] }, location.origin);
}

function renderInspector(root: HTMLElement, current: MatchSession) {
  root.replaceChildren(); const heading = $('div', 'panel-heading'); heading.append($('div', undefined, $('p', 'eyebrow', 'Decision inspector'), $('h2', undefined, current.detail ? 'What did each agent see?' : 'Waiting for records'))); root.append(heading); if (!current.detail) return;
  const records = current.detail.records; const turns = [...new Set(records.filter((record) => record.kind === 'observation' || record.kind === 'action').map((record) => record.turn))].sort((a, b) => a - b); if (!turns.length) { root.append($('div', 'empty-state', current.detail.match.status === 'running' ? 'Decisions become inspectable when the match is complete.' : 'No decision records were stored.')); return; }
  if (!turns.includes(current.selectedTurn)) current.selectedTurn = turns[turns.length - 1];
  const controls = $('div', 'inspector-controls'); const turn = filterSelect('inspect-turn', 'Turn', turns.map((value) => [String(value), `Turn ${value}`])); turn.select.value = String(current.selectedTurn); const side = filterSelect('inspect-side', 'Player', [['all', 'Both players'], ['p1', current.detail.match.p1.name], ['p2', current.detail.match.p2.name]]); side.select.value = current.selectedSide; turn.select.addEventListener('change', () => { current.selectedTurn = Number(turn.select.value); renderInspector(root, current); }); side.select.addEventListener('change', () => { current.selectedSide = side.select.value as Side | 'all'; renderInspector(root, current); }); controls.append(turn.wrap, side.wrap); root.append(controls);
  const selected = records.filter((record) => record.turn === current.selectedTurn && (current.selectedSide === 'all' || record.side === current.selectedSide)); const columns = $('div', 'inspector-columns'); const observations = card('inspector-column'); observations.append($('h3', undefined, 'Observations')); const actions = card('inspector-column'); actions.append($('h3', undefined, 'Actions'));
  const obs = selected.filter((record) => record.kind === 'observation'); if (!obs.length) observations.append($('p', 'muted', 'No observation recorded for this selection.')); obs.forEach((record) => { const data = record.data as Partial<Observation>; const block = $('div', 'record-block'); block.append($('span', 'record-side', record.side?.toUpperCase() ?? 'SYSTEM'), $('strong', undefined, `${Array.isArray(data.events) ? data.events.length : 0} events`)); const events = $('pre', 'record-text'); events.textContent = JSON.stringify(data, null, 2); block.append(events); observations.append(block); });
  const acts = selected.filter((record) => record.kind === 'action'); if (!acts.length) actions.append($('p', 'muted', 'No action recorded for this selection.')); acts.forEach((record) => { const data = record.data as { action?: Action; latencyMs?: number; accepted?: boolean }; const block = $('div', 'record-block'); block.append($('span', 'record-side', record.side?.toUpperCase() ?? 'SYSTEM'), $('strong', undefined, data.action ? actionLabel(data.action) : 'Unknown action'), $('span', data.accepted === false ? 'rejected' : 'accepted', `${data.latencyMs ?? '—'} ms`)); actions.append(block); }); columns.append(observations, actions); root.append(columns);
}

function actionLabel(action: Action) { return action.type === 'move' ? `Move · slot ${action.slot}${action.gimmick ? ` · ${action.gimmick}` : ''}` : `Switch · slot ${action.slot}`; }

async function cancelMatch(id: string) { try { await request(`/api/matches/${encodeURIComponent(id)}/cancel`, jsonBody({})); errorMessage = ''; await loadMatch(id); } catch (error) { errorMessage = error instanceof Error ? error.message : 'Could not cancel match.'; updatePage(); } }

async function loadMatch(id: string) {
  try {
    const detail = await request<MatchDetail>(`/api/matches/${encodeURIComponent(id)}`);
    if (route.name !== 'match' || route.id !== id) return;
    errorMessage = '';
    if (!session || session.id !== id) matchPage(detail);
    else {
      const records = new Map(detail.records.map(r => [r.seq, r]));
      for (const record of session.detail?.records ?? []) if (!records.has(record.seq)) records.set(record.seq, record);
      detail.records = [...records.values()].sort((a, b) => a.seq - b.seq);
      const publicLines = detail.records.filter(r => r.kind === 'public').map(r => String(r.data));
      const changed = publicLines.length !== session.lines.length;
      session.detail = detail; session.lines = publicLines; session.seen = new Set(records.keys());
      patchMatch();
      if (changed && session.viewerReady) sendViewerLoad();
    }
  } catch (error) {
    if (route.name !== 'match' || route.id !== id) return;
    errorMessage = error instanceof Error ? error.message : 'Could not load match.';
    const main = document.querySelector('main')!;
    main.replaceChildren(pageHeading('Match', 'Unable to load this battle', errorMessage), link('← Back to arena', '#arena', 'back-link'));
    session = null;
  }
}

function patchMatch() {
  if (!session?.detail) return;
  const { detail, root } = session;
  root.querySelector('.match-header')?.replaceWith(matchHeader(detail));
  const summary = root.querySelector<HTMLElement>('#match-summary');
  if (summary) renderSummary(summary, detail);
  const pre = root.querySelector<HTMLPreElement>('#public-log');
  if (pre) pre.textContent = session.lines.join('\n');
  const inspector = root.querySelector<HTMLElement>('#inspector');
  if (inspector) renderInspector(inspector, session);
  const note = root.querySelector('.viewer-note');
  if (note) note.textContent = detail.match.status === 'running' ? 'Live' : 'Replay';
  const actions = root.querySelector('.match-actions');
  if (actions) {
    actions.replaceChildren($('p', 'eyebrow', 'Controls'), link('Download replay', `/api/matches/${detail.match.id}/replay`, 'button button-secondary'));
    if (detail.auditAvailable) actions.append(link('Download full audit', `/api/matches/${detail.match.id}/audit`, 'button button-secondary'));
    else actions.append($('span', 'muted', detail.evaluation ? 'Audit unlocks after both evaluation games.' : 'Audit unlocks after this match.'));
    if (detail.match.status === 'running') actions.append(button('Cancel match', () => cancelMatch(detail.match.id), 'button button-danger'));
  }
}

function getRoute(): Route {
  let raw: string; try { raw = decodeURIComponent(location.hash.slice(1)) || 'arena'; } catch { return { name: 'arena' }; } const [name, id] = raw.split('/'); if (name === 'match' && id) return { name: 'match', id }; if (name === 'history' || name === 'leaderboard') return { name }; return { name: 'arena' };
}

function updatePage(fromState = false) {
  const previous = captureFormState(); updateNav(); if (route.name === 'arena') arena(); else if (route.name === 'history') history(); else if (route.name === 'leaderboard') leaderboard(); else if (!fromState && route.id) void loadMatch(route.id); restoreFormState(previous); updateConnection();
}

async function boot() {
  shell();
  window.addEventListener('hashchange', () => {
    route = getRoute();
    if (route.name !== 'match' || session?.id !== route.id) session = null;
    updatePage();
  });
  window.addEventListener('message', event => {
    if (!session || event.origin !== location.origin || event.source !== session.frame.contentWindow) return;
    const data = event.data as { type?: string; turn?: number };
    if (data?.type === 'viewer-ready') sendViewerLoad();
    if (data?.type === 'viewer-turn' && typeof data.turn === 'number' && session.detail?.auditAvailable) {
      const inspector = document.querySelector<HTMLElement>('#inspector');
      if (inspector && !inspector.contains(document.activeElement)) {
        session.selectedTurn = data.turn;
        renderInspector(inspector, session);
      }
    }
  });
  route = getRoute(); updatePage();
  try {
    state = await request<ArenaState>('/api/state'); errorMessage = ''; updatePage(true);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Could not connect to the arena service.';
    document.querySelector('main')?.prepend(errorBanner());
  }
  stream = new EventSource('/api/events');
  stream.addEventListener('open', () => {
    connected = true; updateConnection();
    if (route.name === 'match' && route.id) void loadMatch(route.id);
  });
  stream.addEventListener('error', () => { connected = false; updateConnection(); });
  stream.addEventListener('state', event => {
    state = JSON.parse((event as MessageEvent).data) as ArenaState;
    updatePage(true);
    if (route.name === 'match' && route.id) void loadMatch(route.id);
  });
  stream.addEventListener('match', event => {
    const payload = JSON.parse((event as MessageEvent).data) as { matchId: string; record: StoredRecord };
    appendMatchLine(payload.record);
  });
  stream.addEventListener('finished', event => {
    const payload = JSON.parse((event as MessageEvent).data) as { matchId: string };
    if (route.name === 'match' && route.id === payload.matchId) void loadMatch(payload.matchId);
  });
}

void boot();
