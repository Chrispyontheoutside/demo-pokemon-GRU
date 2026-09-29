const base = process.env.ARENA_URL ?? 'http://127.0.0.1:3000';
async function request(path, body) {
  const response = await fetch(new URL(path, base), body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const json = await response.json();
  if (!response.ok) throw new Error(json.error ?? response.statusText);
  return json;
}
try {
  await request('/api/queue', { agentId: 'random', mode: 'unranked' });
  const state = await request('/api/queue', { agentId: 'heuristic', mode: 'unranked' });
  console.log(`Match started. Watch at ${base}/#match/${state.activeMatch.id}`);
} catch (error) {
  console.error(`Demo: ${error.message}. Start the arena with npm start and ensure the example agents are idle.`);
  process.exitCode = 1;
}
