# Shared implementation contract

Read `src/contracts.ts` for the agreed data structures. Do not change them without coordinating with root. The repository is shared; respect assigned file ownership. Follow ponytail: native libraries first, no speculative abstractions. All application code is TypeScript, compiled with tsc to dist. Python examples use only stdlib.

## HTTP contract (root implements)

- GET /api/state -> ArenaState, matches most recent first, all leaderboard rows.
- GET /api/matches/:id -> MatchDetail. records are ONLY kind public while live or evaluation incomplete. After completion include all except input; full audit download has everything.
- POST /api/queue {agentId, mode} -> ArenaState; DELETE /api/queue/:agentId -> ArenaState.
- POST /api/evaluations {p1Id,p2Id} -> {id}; unranked two games, same seed, players swapped, serial scheduler.
- POST /api/matches/:id/cancel -> {ok:true}.
- GET /api/matches/:id/replay -> text/plain spectator log download.
- GET /api/matches/:id/audit -> JSON {match,metadata,records}; 409 until completed and evaluation completed. Metadata is MatchPrivate.
- GET /api/events -> SSE events `state` (ArenaState), `match` ({matchId,record:StoredRecord} ONLY public), `finished` ({matchId}). SSE reconnect re-fetches state/detail, uses persisted match records as source of truth. API error JSON {error:string}.
- / -> public/index.html; /app.js -> dist/web/app.js; /styles.css -> public/styles.css.
- /viewer.html -> public/viewer.html, /viewer.js -> public/viewer.js, /vendor/* pinned renderer runtime assets.

## Viewer iframe contract

UI creates iframe src /viewer.html and listens for `{type:'viewer-ready'}` from iframe. UI sends `{type:'load',lines:string[],live:boolean}` once loaded, then `{type:'append',lines:string[]}`. Viewer owns play/pause, turn seeking, speed, live controls, muted default and loading errors. Messages use same-origin target/source validation. Viewer sends `{type:'viewer-turn',turn:number}` so decision inspector may follow selected turn. Reconnect can reset via load. Only spectator lines enter renderer.

## Engine contract

Export `runMatch(options:RunMatchOptions):Promise<MatchResult>` from src/battle.ts. Export action enumeration/validation helpers for tests. onRecord is synchronous and writes to SQLite before action/observation proceeds. public record data is a SINGLE Showdown protocol line string. action record data = {requestId,action,latencyMs,accepted:boolean}; observation record data is Observation; input record data is protocol input string. Capture all simulator start/player/choice/forcewin inputs for reproducibility. Input log should reproduce output even with forfeit. No timing chatter in spectator log.

Python process startup: parent writes one JSON line `{type:'init',protocolVersion:1,matchId,side,policySeed,config}`. Child responds `{type:'ready',protocolVersion:1}`. Afterward parent writes Observation JSON directly; child responds DecisionResponse JSON. Final parent message `{type:'end',winner,reason}`. Harness wraps user decide() return in request ID. Stdout protocol only. Move mechanics public data can be generated from pinned Showdown Dex to agents/moves.json by a script owned by engine agent.

## Store contract

Export ArenaStore from src/store.ts: constructor(path:string); createMatch(summary:MatchSummary,metadata:MatchPrivate):void; appendRecord(matchId:string,record:MatchRecord):StoredRecord; finishMatch(id:string,result:MatchResult):MatchSummary; getMatch(id):MatchSummary|undefined; listMatches():MatchSummary[]; getRecords(id):StoredRecord[]; getPrivate(id):MatchPrivate|undefined; leaderboard():LeaderboardEntry[]; recover():void; close():void. finishMatch merges private teams/inputLog, applies Elo only once for completed ranked. recover interrupts still-running matches without rating changes. Record public turn markers should update stored match turn. Evaluation membership uses groupId; root persists evaluation state through group matches, and prevents audit when queued/running second game.

## Defaults

Gen 9 Random Battles, one battle at a time, FIFO once per queue entry, default 10s startup/decision, 5m total player time, 15m watchdog. Agent errors during play forfeit, setup/engine/cancel errors interrupt unrated. Side-private requests plus getPlayerStreams redaction; no hidden state for action generation. Private audit stays locked across evaluation pair. Trusted local subprocesses, loopback HTTP, no shell. Root handles HTTP, queue, metadata hashes, security, integration, final browser QA.
