# Pokémon Champions VGC 2026 Reg M-C — live status

Updated: 2026-09-29 09:15 UTC (04:15 CDT)  
**Success condition (raised by the user at ~20:25 CDT): a frozen, locally trained agent reaches ≥1250 real rated Elo** on `gen9championsvgc2026regmc` — **target date: end of 2026-09-28 (local)**. 1200 is now a milestone on the way, no longer the goal. Against ~1100-rated opponents 1250 sustained needs roughly a 70% win rate (the best configuration is at ~61%). Real ladder Elo is the scoreboard; everything else is a means.

**Latest instruction (user, ~21:55 CDT): target ≥1300 real rated Elo; work autonomously overnight; report in the morning.** 1200 and 1250 are milestones on the way; earlier chain follows.

**Goal chain (user, ~20:35 CDT):** achieve ≥1250 real rated Elo; **as soon as it is reached, set the goal to ≥1400** and keep going (freeze the ≥1250 configuration first: weights, team, inference settings, training history, ladder record, hashes). Experiment-fleet decisions are left to my judgment.

**Fleet update (20:45 CDT):** measured steady-state rates with 9 runs (load average ~20 on 10 cores): warm-started GRUs 7–32 battles/sec, wide/deep GRUs 14–19, transformers only ~4 (30k battles would take ~2 h). I culled the feed-forward transformer and the Salazzle transformer, keeping one transformer (`f07-tfgru-team1`, GRU on team 1) so that architecture still gets a trial; 7 runs remain (`arch-20260928/*`, `replicate-20260928/rp-team1`, `fleet-20260928/f05,f06,f07`).

**Fleet decision (20:35 CDT):** the user asked for 15 parallel experiments; I planned 9 instead. Aggregate simulator throughput saturates at ~160 battles/sec on this 10-core, 16 GB machine (memory is already tight: ~0.1 GB free, 5.8 GB compressed), so 15 runs would get ~10 battles/sec each and none would reach a competitive battle count before the ladder-testing window closes. Nine runs at ~15–40 battles/sec finish 30k–60k-battle snapshots in about an hour. Architectures in the fleet: 64-unit GRU (warm-started, several teams), fresh 64-unit GRU, wide GRU (192), deep GRU (128×2), and an entity transformer (13 tokens: global + 12 Pokémon; feed-forward and GRU variants; Python↔Node parity tested).

## MORNING REPORT (draft written 05:15 CDT; details in the journal below)

**Outcome: the target was not reached. Best real rating touched 1218 once (not sustained); the account has spent the night between ~1000 and ~1190 and sits around 1030–1100.** No ≥1200 milestone is frozen; milestones **1050 and 1100 are frozen** for the control.

1. **Best real ladder Elo:** peak **1218** (deeper 128×2 GRU, `abe0892d879b`, during an 8-8 run; it finished 14-21 over 35 games, so not credible). Best sustained: control `42159b07ffa5` peaked at 1184.
2. **Best credible configuration:** the **control** — team-1 (Clawitzer / Hisuian Arcanine / Snorlax / Eternal Floette / Hydreigon / Torkoal) 80k-battle GRU specialist `42159b07ffa5`: 45-36 raw over 81 games, ~57% raw, hash-frozen in the registry.
3. **Genuine W/L (early-forfeit and timer wins excluded):** control **34-36 (49%)**; its 45 wins split 24 normal / 10 substantial-play forfeits / 10 early forfeits / 1 timer. Every other configuration tested lands at 33–54% genuine: r2-tauros 7-6, sp-gru-t2@80k 4-5, rp-team1 (replicate) 4-4, evo-1@40k 12-14, evo-2@40k 5-9, evo-1@240k 5-10, guarded-opponent g1 7-13, shaped s1 2-8, m4-salazzle 2-7, deeper GRU 13-21.
4. **What worked (as engineering/measurement, not as Elo):** 2.3× single-experiment and ~3.5× aggregate training throughput with bit-exact reproducibility; hash-keyed checkpoint/ladder registry with sustained-play milestone rules and per-game ending classification (revealed the control's true ~49%); local team search and evolutionary team discovery (found Sneasler/Talonflame/Vanilluxe/Aerodactyl-style cores by itself); exact simulator-vs-Node parity for GRU/wide/deep/transformer architectures; an autonomous single-client ladder queue.
5. **What failed to move the ladder:** more capacity (wide, deep, entity transformer), more training (240k was worse than 40k), larger/harder opponent pools, exploiters, main-line league vs exploiters, evolved coherent teams, potential-based reward shaping, a Protect/Fake-Out/switch-aware scripted opponent, switch-exploration mixture in the behaviour policy, and unconditional preview search. Local metrics (heuristic anchor, held-out teams, vs-champion) failed to predict ladder results **at least six times** — including specialists that beat the champion 82–89% locally.
6. **Strongest evidence about the bottleneck:** a behavioural gap that no training variant closes. Over 279 ladder games: **voluntary switches per game — us 0.03, human opponents 0.48; Protect share of moves — us 4.5%, humans 11.8%.** Every specialist's deployed switch rate is 0.2–2% (also with 15% switch exploration). Combined with the meta-team observation (our win rate is worst against Sneasler/Kingambit/Rillaboom/Gholdengo cores, 29–32%), the picture is: the local opponent distribution is passive and unlike ladder play, so policies that dominate it (80–95% vs heuristic) are only ~even against real players. It is play quality/opponent pressure, not architecture, scale or reward density.
7. **Recommendation:** (a) build a training signal that makes switching pay — simulator search: clone a Battle mid-game (`toJSON`/`fromJSON`), roll out each candidate (including switches) against sampled opponent actions, and distil the search into the policy (expert iteration) or use it at inference; this addresses the actual gap and is independent of the opponent-distribution problem; (b) decide whether aggregate observed opposing species from your own ladder games may weight local opponent-team generation (I did not use them; it edges into human data); (c) judge every change with ≥30 genuine ladder games — the ladder gives ~10–20 games/hour overnight, so plan evaluation time; (d) stop scaling the current recipe.

**Feasibility check for recommendation (a):** `Battle.toJSON()` / `Battle.fromJSON()` exist and work in the pinned simulator: a mid-battle clone gives **identical HP after identical choices** (deterministic PRNG state carried), costs ~0.37 ms and ~30 KB per clone. So a design is buildable next session: at each decision, clone, apply each candidate action (including voluntary switches and Protect), roll both sides out to the end with the current policy/league policies (or a value-head cutoff after 1–2 turns), and either (i) distil the search-improved action distribution into the policy (expert iteration; deployable without state reconstruction) or (ii) use it as an auxiliary switch-value target. Implementation notes: `play()` currently drives `BattleStream`; the search needs the direct `Battle` API (`makeChoices`, `requestState`, side `getRequestData`) plus a way to render each side's request into the existing encoder input; budget ~10–20 candidates × 4–8 rollouts per decision. Test script: scratchpad `clone-check.mjs` (logic: construct `Battle`, `makeChoices('team 1234','team 1234')`, `makeChoices('default','default')`, `toJSON` → `fromJSON`, compare).

**Rollout search prototype (built and measured 05:30–06:40 CDT):** `src/direct-battle.ts` (direct `Battle` driver with `clone()`, per-side views/requests, tested: full games, deterministic mid-game clones, independent views), `src/search.ts` (clone → try each candidate incl. best voluntary switches → roll out with policies → average outcome), `scripts/search-eval.mjs` (paired search vs plain, same seeds), `scripts/search-label.mjs` (expert-iteration labels), 26 Node tests pass. Measured on held-out evo-13..24 teams, control policy on team 1, 200 paired games, 6 rollouts × 10+4+2 candidates:
- Rollouts using the **true opponent's policy**: 0.79 → **0.995** vs heuristic, 0.835 → **0.97** vs champion (voluntary switches per game 0 → 0.21–0.31). This is an upper bound: it uses the real opponent's behaviour AND a clone that contains the opponent's true hidden sets.
- Rollouts using **the learner's own policy as the opponent model** (what a deployable searcher could assume): 0.79 → **0.84** vs heuristic, 0.835 → **0.855** vs champion (+5 / +2 points, CI-overlapping). Voluntary switches 0 → 0.26–0.31 per game *under softmax sampling*, but the search's argmax action is a voluntary switch in only **1.1%** of decisions (labeller smoke run), i.e. switching rarely wins even with lookahead against these opponent models.
- Conclusion: realistic deployable gain is small (a few points); the large local gain came from knowing the real opponent. Real-time ladder search would additionally need battle-state reconstruction with sampled opposing sets (not built). Distilling this search is not expected to close the switching/Protect gap versus humans. Left as tooling for later; not pursued further tonight.

**Latest control record (05:54 CDT): 52-45 raw over 97 games, genuine 40-45 (47%); ladder peak 1204 for this configuration, overall account peak 1218 (different configuration); no ≥1200 milestone frozen.**

**FINAL control record (queue finished at 07:04 CDT): 65-55 raw over 120 games, genuine 50-55 (48%), final 1163, control peak 1204; overall account peak 1218 (deeper GRU, 35 games, not sustained). The ladder queue has stopped; caffeinate is still running. No ≥1200 milestone is frozen (registry rule: ≥50 rated games with both the final rating and the last-25-game mean at or above the threshold).**

**1250 evidence watcher (added 07:50 CDT at the user's request):** `scripts/watch-milestone.py 1250` (running; log `.cache/watch-milestone.out`) fires the first time a rated **win** leaves the account at ≥1250. It saves the server's battle log (including the official rating-change message), the decision log, the session summary, read-only copies of the exact policy and team, and an auto-generated `REPORT.md` under `milestones-live/elo-1250-<time>/`, with the sustained-play credibility check (≥50 rated games, final and last-25-game mean ≥ threshold). **A real screenshot currently fails** (`screencapture`: "could not create image from display"): the terminal app needs Screen Recording permission (System Settings → Privacy & Security → Screen & System Audio Recording) and the display must be awake; without it the report records the failure and the battle log is the evidence. The pipeline was dry-run against an old game at threshold 1100 (works).

**Expert-iteration hill-climb, iteration 1 (08:40 CDT, negative):** labels `expit/it1-labels.jsonl` (2,000 games of the control on team 1 vs heuristic / champion / generalist / replicate on evo-1..12 teams; 8,521 searched decisions; 6 rollouts × 16 candidates; 17.7 min on 6 processes). First attempt trained toward softmax(Q/τ) targets and failed (targets too noisy: held-out argmax agreement fell 0.22→0.12 while cross-entropy fell). Second attempt used the prior-weighted improvement target π_ref·exp((Q−Qmax)/τ) (τ=0.2, KL anchor 0.2, 15 epochs): held-out cross-entropy 2.85→1.88, KL to the start 0.18, no overfitting. **Student vs teacher on held-out evo-13..24 teams (200 pairs):** vs heuristic 0.805 vs 0.853, vs champion 0.765 vs 0.775 — no improvement (within noise); voluntary switch rate 0.000→0.018, Protect 0.086→0.091. Consistent with the measured ceiling of fair-opponent-model search (+2–5 points): a student cannot exceed its teacher. Tooling kept: `agents/finetune_search.py` (`--init --labels --output --tau --anchor`), `scripts/search-label.mjs`. Not put on the ladder (no local gain).

**Account naming (user request, 08:35 CDT):** the ladder identity file `.cache/champions-vgc-2026-reg-mc-ladder-user.json` now names the account `avin-owes-me-25` for all NEW sessions (backup of the old identity: `.cache/champions-vgc-2026-reg-mc-ladder-user.ChampionsMC808583.json`). It is a new, unregistered account, so its rating starts at 1000 with no history; all earlier records above are for `ChampionsMC808583`. The registry and watcher read ratings from session summaries, so the rating table now mixes two accounts by session.

**Own-battle data as training input (user permission ~08:10 CDT: "you can use battles you faced online as training data, but only battles we have fought")**
- `scripts/extract-human-teams.py` → `human-teams/raw.json`: 388 opposing teams from our own ladder logs (345 distinct species sets; Sneasler on 33% of teams, Rillaboom 33%, Incineroar 31%, Garchomp 21%, Indeedee-F 19%, Gholdengo 18%), with every move/item/ability revealed in play (2,158 revealed moves, 556 items).
- `scripts/build-human-teams.mjs` → 385 validated legal teams (`teams/human-*.json` 325 train, `human-heldout-*.json` 60 held out for evaluation only): observed species + all revealed moves/items/abilities, gaps filled from per-species frequencies pooled over our games, stat points from the project optimiser.
- **The first local yardstick that predicts the ladder:** scoring each ladder-tested candidate on its own team vs the heuristic as pilot on the 60 held-out human-like teams correlates with its genuine ladder win rate at **Pearson r = +0.61 (Spearman +0.52, 13 configurations; +0.74 over the 5 with ≥15 ladder games)**; the champion-as-pilot version does not (r ≈ −0.02). Small n and noisy ladder rates: encouraging, not proof.
- **Hill-climb (`humanclimb-20260929/`)**: `hc-team1` (from the control), `hc-tauros` (from r2-tauros), `hc-evo1` (from e1-evo1@40k); opponents heuristic 35% / guarded heuristic 25% / self-play 20% / generalist pool 20%, opposing teams from 150 human-like teams every game; snapshots every 20k battles to 60k. On fresh seeds (300 pairs, held-out human teams, heuristic pilot): hc-team1 0.878 vs control 0.850 (+0.028), hc-evo1 0.868 vs e1@40k 0.820 (+0.048), hc-tauros 0.865 vs r2-tauros 0.870 (−0.005). Weak positive (CIs overlap). `hc-evo1@60k` (`9b22003641ec`) and `hc-team1@60k` (`a9e64b1855c0`) are queued on the ladder (24 games each) ahead of the control.
- Plumbing added: `--opponent-team-share`, worker-side caching of large team sets, `--pool ckpt@team`.

**Human-behaviour calibration from our own games:** the guarded scripted opponent (`heuristic2` kind, `guardedAction`) was tuned so that, playing itself on human-like teams, it matches the aggregate rates observed in our 279 ladder games: **0.50 voluntary switches per game per side (humans 0.48) and 12.8% Protect share of moves (humans 11.8%)**, from defaults of 0.033 and 3.8% (the plain heuristic: 0.017 and 0.3%). Parameters are the code defaults now (`DEFAULT_GUARD`; env `GUARD_TUNING` overrides); tool: `scripts/measure-behavior.mjs`. Earlier `g1/g2` and `hc-*` runs used the old defaults. The evaluator can also score against this pilot (`EVAL_GUARDED=1`). **Caveat: this calibrated pilot predicts the ladder worse than the plain heuristic pilot** (Pearson +0.38 vs +0.61 over 13 configurations; standard error of r ≈ 0.27 at n=13), so neither local yardstick is established; only the ladder A/B decides.

**Hill-climb rounds (all 300 pairs, seed 3500000000, held-out human-like teams, heuristic pilot / calibrated pilot):** round 1 (`humanclimb-20260929`, plain+guarded heuristics, 150 human teams): `hc-team1` .878 (control .850), `hc-evo1` .868 (parent .820), `hc-tauros` .865 (parent .870). Round 2 (`humanclimb2-20260929`, calibrated human-behaviour opponent 50%, from the round-1 snapshots): `hd-team1` **.902 / .885** (parent .878 / .873), `hd-evo1` .852 / .877 (parent .868 / .857). Round 3 (`humanclimb3-20260929`, from `hd-team1@60k`, all 325 human teams, two seeds): `h3-team1a` .895 / .870, `h3-team1b` .875 / .858 vs parent .902 / .885 — **no further gain; the local climb plateaued at ~0.90.** Ladder so far for the round-1 evo-1 candidate `9b22003641ec`: 15 games 7-8, genuine 5-8 (38%), rating 1107, peak 1156 — the same as every earlier family. Team-1 lineage total so far: control .850 → .878 → .902 on the heuristic pilot (+0.05). Gains are shrinking round over round and the yardstick's link to the ladder is weak, so the ladder decides.

**Hill-climb ladder results (10:20 CDT, account `avin-owes-me-25`): the human-team hill-climb did not improve real ladder strength.** `hc-evo1@60k` (`9b22003641ec`, +0.048 on the local yardstick): **12-12 over 24 games, genuine 10-12 (45%)**, rating 1122, peak 1174 — identical to the ~46% baseline. `hd-team1@60k` (`1a10c409609d`, +0.05 over the control on the yardstick): **6-11 after 17 games, genuine 6-11 (35%)**, rating 1036 — if anything worse than the control. So a local gain of ~5 points on human-like teams, and human-calibrated opponent behaviour, did not transfer; this joins the earlier failed proxies. (The yardstick's ladder correlation was r=+0.61 at n=13 with SE≈0.27, i.e. weak; these two points do not support it.)

**Structural conclusion (10:55 CDT) — why every local improvement stops at the ladder:** everything we can train against locally is weak relative to the ladder population. The heuristic and its human-calibrated variant saturate (our policies score ~0.90 against them), our own policies/league are limited by the same model, and search with a fair opponent model adds only +2–5 points. Local hill-climbing therefore optimises against opponents that a ~1100-rated human already beats, so it cannot register as skill against stronger humans (ladder genuine win rate stays 32–47% for every variant, including the two human-team hill-climb candidates, 12-12 and 10-19). The only source of *strong* opponents is the ladder itself; our own battles are the permitted data, but ~400–500 games (≈5k decisions per side) are too few to imitate a human policy well, and games arrive at only ~10–20 per hour. Realistic path (multi-day, not tonight): keep playing the best configuration to grow our own battle archive (~300–500 games/day), periodically rebuild (a) human-like opponent teams and (b) an imitation-learned human-like opponent from the archive (reconstruct each human decision state by replaying the logged battle in the local simulator with the built teams), train against it, and judge each step with ≥30 genuine ladder games. Two smaller options: ladder-side search with battle-state reconstruction (fair-model gain only +2–5 points locally) and a larger search budget. None of these is expected to reach 1250 by itself.

**Ladder queue now (`.cache/ladder-queue.json`, new account `avin-owes-me-25`):** `hc-evo1@60k` (`9b22003641ec`, evo-1 team) to 24 games — 7 games 3-4 (genuine 2-4) at 08:53; then `hd-team1@60k` (`1a10c409609d`, team 1) to 30 games; then the control `42159b07ffa5` (team 1) to 200 total games (the control's baseline is ~46% genuine over 140 games, ratings 1043–1150 on the new account). Compare each candidate's genuine record with that baseline.

**Exact next actions if tool access drops:** (1) read `node scripts/champions-registry.mjs ingest-ladder runs/champions-vgc-2026-reg-mc/ladder/*/summary.json` and compare `9b22003641ec`, `1a10c409609d` genuine records with the control's ~46%; (2) score `humanclimb3-20260929/h3-team1{a,b}/policy-60000.json` with `scripts/eval-candidate.sh <label> <ckpt> teams/candidate-1.json <60 held-out human teams comma list> "" 300 3500000000` (EVAL_GUARDED=1 adds the calibrated pilot) and register/queue any that beat `hd-team1` (.902); (3) if a candidate reaches ≥60% genuine over ≥24 games, extend it to 50 games and keep hill-climbing that lineage; if the candidates sit at ~46% like every earlier family, the human-team distribution alone does not close the gap.

**Bug fixed (09:00 CDT):** for account names containing punctuation (`avin-owes-me-25`) the adapter failed to match its own rating message, so summaries recorded `ratingAfter: null`. Adapter now normalises both sides; the registry and `watch-milestone.py` also recover the rating from the server's rating line in the battle log, so past sessions are readable. The 1250 watcher was restarted with the fix. `avin-owes-me-25` so far: 11 games, rating range 1043–1117.

**State left running:** `caffeinate`, the ladder queue (`.cache/ladder-queue.py`; stop with `touch .cache/ladder-stop`) — from 05:15 CDT the queue plays only the control `42159b07ffa5` on team 1 up to 120 total games (bounded final state; it stops on its own). Last exploiter probes: `ex-tauros@30k` 3-6, `ex-tyrantrum` not reached; shaped `s1` finished 3-9 (genuine 2-9). Sleep prevention was missing until 00:10 CDT — the machine had been in maintenance sleep, which cost ~2 hours of ladder/training time earlier in the night.

## OVERNIGHT JOURNAL (started 22:00 CDT; target ≥1300, milestones 1200/1250; rules: ladder evidence outranks local proxies)

**Ground truth about the control `42159b07ffa5` (team 1, 80k):** 41-36 on paper, but wins split into 21 normal, 9 substantial-play forfeits, 10 early forfeits, 1 timer. **Genuine record (early forfeits/timers excluded) 30-36 (45%)**; only 27% of its games are completed normal wins. Its ~1100 rating is partly opponents leaving. Real strength vs ~1100-rated players is below even. `champions-registry.mjs ingest-ladder` now classifies every game's ending and prints a genuine record per checkpoint.

**Infrastructure incident (found ~00:10 CDT):** the Mac was repeatedly entering Maintenance Sleep (~12 min asleep, ~1 min awake) because nothing held a sleep assertion, plus one "Dark Wake Thermal Emergency" sleep at 22:55 under load average ~22. Effects: four consecutive ladder sessions (22:37–23:28) timed out with 0 games ("Connection or battle progress timed out", the websocket died in sleep), and training ran at a fraction of its nominal rate from ~22:50. **Fix:** `caffeinate -dimsu` now runs in the background (assertions verified), and load was cut to 2 trainers + the ladder client. Ladder results recorded before this are unaffected (games either completed or the session recorded 0 games), but no candidate has been ladder-tested since the m4 probe was queued at 22:18. Lesson: keep ≤ ~4 busy trainers; check `pmset -g log` when sessions time out.

**Findings tonight**
1. Local numbers do not predict ladder results (heuristic anchor 0.88 → 39% for the deeper GRU; 150k specialist beat the 80k locally but went 3-9). Round-robin among local agents is non-transitive: the Tauros-team exploiter beats the control 89% and the champion 79% but loses to the control's own replicate (`rp-team1`, wins 70%).
2. **Team matchup is a major lever:** exploiters on other strong teams beat the control heavily (Tauros 89%, Tyrantrum 82%, Grimmsnarl 63%) while the exploiter on the control's own team gets 46%.
3. Seed variance is large: replicate of the control recipe scores 0.72 vs the heuristic on strong teams (control 0.90).
4. Architecture fleet (deeper/wider GRU, entity transformer) did not show a ladder-relevant win; transformer trains ~4 battles/sec (needs optimising before real investment). Parity-tested code exists for both.
5. Wins by opponent forfeit at turn ≤2 happen ~13% of games; they inflate rating.

**Preview-search experiment (negative):** `scripts/preview-search.mjs` rates all 90 lead/bring options (`team abcd`) for a fixed policy + team by simulator win rate (heuristic + two frozen generalists, coherent opposing teams). For the control on team 1 the options span **12%–78%** (median 45%), so preview matters a lot, but the top-3 options do **not** hold up on held-out teams (0.57, 0.76, 0.45 vs 0.76 for the policy's own conditional preview): the search winners were selection noise, and the policy already picks previews that adapt to the opposing team. Conclusion: an unconditional forced preview is worse than the learned one; preview is not the bottleneck. (Conditional preview search would need opponent-set sampling; not pursued.)

**Aggregate ladder diagnostic (own games only, 199 parsed):** our overall win rate 44%; opposing teams are meta-style cores — most common opposing species Incineroar (61 games, we win 41%), Rillaboom (60, 32%), Sneasler (58, 29%), Garchomp (45, 36%), Salamence, Raichu, Farigiraf, Gholdengo (29, 31%), Kingambit (28, 29%). Our training opponents (random or randomly-searched teams) rarely contain such coherent cores, i.e. a distribution shift. I did **not** feed observed species into training (would edge into using human data) — open question for the user.

**Evolutionary team discovery (`scripts/team-evolve.mjs`, run 06:00 UTC):** 240 teams × 12 generations, fitness = simulator win rate of a generalist pilot vs heuristic + frozen generalists, opposing teams co-evolved from the current elite (children validated by the format validator). It converged to teams built around **Sneasler, Talonflame, Vanilluxe, Aerodactyl, Luxray, Incineroar/Garchomp** (elite mean 0.83 vs a population median of 0.70), i.e. the local search independently found meta-relevant species. Top 24 saved as `teams/evo-1..24.json` (evo-13..24 are held out from all training).

**Evolved-team specialists (running, `evo-20260929/`):** `e1-evo1`, `e2-evo2`, `e3-evo3` — warm-started from the champion, learner on evo-1/2/3, opponents heuristic 15% / self-play 35% / pool 50% (champion, `sp-gru-all`, `r2-tauros` on its native team), half of non-self-play opponents on evo-1..12 teams; stages 40k then 80k. Evaluate on held-out evo-13..24 opposing teams, then ladder.

**Evolved-team specialists at 40k (held-out evo-13..24 opposing teams, 150 pairs; policy on its own team):** e1-evo1 heuristic 0.84 / vs champion 0.82; e2-evo2 0.94 / 0.86; e3-evo3 0.92 / 0.82; the champion on evo-1 as a team-only baseline scores 0.77 / 0.59. All three registered (`e35a37dac682` evo-1, `601eba1dd660` evo-2, `ae2d7836a417` evo-3) and queued first on the ladder. **Early ladder reading (01:25 CDT): `601eba1dd660` (evo-2) 3-1 (two normal wins, one substantial-play forfeit), rating 1190** — far too few games to conclude anything; the queue continues to 15 games, then evo-1, evo-3.

**Update 01:55 CDT.** Ladder (genuine records, wins by early forfeit/timer excluded): evo-2 specialist@40k `601eba1dd660` 6-9 (genuine 5-9) → clearly inferior, reverted; `sp-gru-t2@80k` `d16f8e65c1fb` 7-5 (genuine 4-5); `m4-salazzle@40k` 2-7; `r2-tauros@120k` 7-6 (genuine 7-6); `rp-team1@80k` 4-4; control `42159b07ffa5` 45-36 (genuine 34-36). **Every specialist family lands at ~40–55% genuine wins regardless of how strong it looks locally.** Local metrics (heuristic anchor, held-out teams, vs-champion) have now failed to predict ladder results five times.

**New experiments running**
1. *Long-training test* (`evo-20260929/`, resumed from 80k toward 400k battles, snapshots at 160k/240k/320k/400k): `e1-evo1`, `e2-evo2` (e3 stopped to cut load). Question: does scale on a diverse coherent league help where 80–150k did not?
2. *Potential-based reward shaping* (`shaped-20260929/`, `--shaping 0.4`, 40k then 80k, 1 worker each): `s1-evo1`, `s2-evo2`, `s3-evo3`, identical recipe to `e1..e3` except the shaping. Rationale: the terminal ±1 reward over ~10 decisions gives the critic explained variance of only ~0.1–0.2; shaping F = γΦ(s')−Φ(s) with Φ = (own HP − opposing HP)/4 (policy-invariant, seen-information only) densifies credit. Compare `s*` vs `e*` at equal battles on held-out evo-13..24 teams, then on the ladder (the only trustworthy judge).
Code: `--shaping` in `agents/train_champions.py` (default 0, unchanged behaviour), `potential()` in `src/champions.ts`, per-step `potential` from `play()`; unit-tested.

**Results as of 03:20 CDT (all ladder numbers are genuine records, early-forfeit/timer wins excluded):**
- Scale test: same team/recipe, evo-1 specialist at 40k battles 12-14 (46%) vs at 240k 3-7 so far (12 games) → **more training did not help**; the 400k continuation was stopped.
- Evolved-team specialists: evo-1@40k 12-14, evo-2@40k 5-9, evo-1@240k 3-7 (in progress); all ~35–50%.
- Reward shaping (0.4): locally indistinguishable from plain at 40k (heuristic 0.76/0.91/0.92 vs 0.84/0.94/0.92; vs champion 0.80/0.85/0.85 vs 0.82/0.86/0.82); ladder A/B (same team evo-1) queued after the 240k test.
- **No train/test observation mismatch from Open Team Sheets:** neither the local training stream nor any of 418 ladder logs contains `|showteam|` lines (only the OTS consent prompt), so policies see the same opposing information in both places. The rules-diff report shows no simulator/server discrepancy that would explain the gap.
- Explanation still standing: policies are ~50% vs the ~1100-rated ladder population regardless of local strength; the ladder population plays meta-style teams and the local opponent distribution, however diverse, is not that distribution.

**Behavioural gap vs real players (measured 04:05 CDT, 279 ladder games, both sides parsed from battle logs):** Protect share of moves — us 4.5%, human opponents 11.8%; **voluntary switches per game — us 0.03, humans 0.48 (16×)**. No training variant changes this: switch rate (per slot decision) is 0.2–2% for plain (`e1/e2`), shaped (`s1/s2`) and guarded-opponent (`g1/g2`) specialists at 40k; Protect share ranges 0–20% without tracking ladder results. Policies learn "never switch" because nothing in the local opponent mix punishes staying in; scale (240k), reward density (shaping) and a Protect/Fake Out/switch-aware scripted opponent all leave it unchanged. This is the clearest concrete bottleneck: the learner needs training pressure that makes switching pay (e.g. a search/lookahead-derived or simulator-derived counterfactual signal for switch value, or opponents that exploit stay-in play).
**Guarded-opponent specialists** (`guard-20260929/`, `--opponent-mix heuristic2=0.3,selfplay=0.3,pool=0.4`; `heuristic2` = damage heuristic + Protect/Fake Out/hurt-switch bonuses, training opponent only): `g1-evo1` ladder 3-4 after 7 games (in progress).

**Switch-exploration experiment (negative):** `--switch-exploration 0.15` mixes 15% of behaviour-policy mass uniformly over voluntary-switch candidates during training (exact mixture log-probs in PPO; deployed policy is unmixed; Python↔Node parity tested). Specialists `x1-evo1`, `x2-evo2` (`explore-20260929/`): deployed switch rate at 40k is 0.7–0.8% of slot decisions (plain 0.2%/2.1%), low-HP switching 0%. Even with the learner seeing plenty of switch outcomes, switching does not pay against the local opponent distribution, so the policy correctly (for that distribution) never does it. Real players switch 0.48 times per game, so the local opponents are too passive/predictable in exactly the way that matters.

**Autonomous state / exact next actions (written 01:30 CDT in case interactive tool access drops):**
- Still running without me: `caffeinate -dimsu` (sleep prevention), `.cache/ladder-queue.py` (queue in `.cache/ladder-queue.json`: evo-2 specialist to 15 games, then evo-1 and evo-3 to 12, `sp-gru-t2@80k` to 12, then the control up to 100 games; stop with `touch .cache/ladder-stop`), and the evolved-team league (`evo-20260929/`, `run-champions-league.sh` → 80k snapshots `policy-80000.json` per experiment).
- On resume: (1) `node scripts/champions-registry.mjs ingest-ladder runs/champions-vgc-2026-reg-mc/ladder/*/summary.json` and read genuine records per checkpoint; (2) if an evolved specialist's genuine win rate ≥ ~60% after ≥12 games, extend it to 30–50 games; if ≤ 45%, revert to the next queue entry; (3) evaluate the 80k evo snapshots with `scripts/eval-candidate.sh <label> <ckpt> teams/evo-K.json <held-out evo-13..24 team list> <champion> 150` and register/queue survivors; (4) next research step if evolved specialists transfer: evolve a second, stronger generation of teams (co-evolve against the new specialists) and iterate the league; if they do not transfer, the bottleneck is play quality vs humans, not team/opponent distribution.
- Rules in force: ladder evidence outranks local proxies; one ladder client at a time; do not overwrite frozen milestones (1050 and 1100 frozen for `42159b07ffa5`); classify wins by ending and quote the genuine record.

**Ladder sweep (successive halving on the ladder itself, since local proxies failed)** — table updated by `ingest-ladder`; probes so far: `r2-tauros@120k` 7-6 (genuine 7-6), `sp-gru-t2@80k` 2-1 (early), `m4-salazzle@40k` 2-7, `rp-team1@80k` 4-4, control 45-36 (genuine 34-36). Rate is only ~15–20 games/hour overnight.

**Running now**
- **Ladder queue** (`.cache/ladder-queue.py`, config `.cache/ladder-queue.json`, one client at a time, 3-game sessions, skips candidates that already have their quota): 24 games each for `rp-team1@80k` (`9c84a4587a3c`, team 1), `ex-tauros@30k` (`66d33af75e6a`, Tauros team), `ex-tyrantrum@30k` (`9c185d42edf4`, Tyrantrum team). Stop with `touch .cache/ladder-stop`. Results land in `runs/.../ladder/*/summary.json`; run `node scripts/champions-registry.mjs ingest-ladder runs/champions-vgc-2026-reg-mc/ladder/*/summary.json` for per-checkpoint records.
- **Main-line league** (`main-20260929/`, stages 40k then 80k): `m1-team1`, `m2-tauros`, `m3-grimm`, `m4-salazzle`, all warm-started from the generalist champion, opponents heuristic 10% / self-play 30% / pool 60% where the pool is the control, the replicate and four exploiters, **each pool policy now playing its own native team** (new `--pool ckpt@team.json` syntax; previously pool policies often played mismatched random teams). Clean held-out opponents for evaluating them (never in this pool): champion `da512c72a479`, fresh 64-GRU (`arch-20260928/ar-gru-w64-fresh`, live snapshot in scratchpad), heuristic/random.
- Exploiters (`exploit-20260929/`, 30k each, trained only against the control): `ex-tauros`, `ex-grimm`, `ex-tyrantrum`, `ex-mirror`; registered.

**Next actions** (in order): (1) when the ladder queue finishes a candidate, compare its genuine record with the control's 30-36 and the replicate's; (2) evaluate main-line 40k snapshots on held-out opponents with `scripts/eval-candidate.sh`, kill weak lines, promote survivors into the ladder queue; (3) iterate exploiters against the best main-line agent (league loop); (4) if policy-only changes plateau, prototype cheap search (rollouts against learned opponent policies) offline first; (5) never overwrite frozen milestones (registry milestones 1050 and 1100 frozen for the control).

## Snapshot at 21:40 CDT (about 2h20m left)

**Ladder (all rated): best rating 1218 (touched once), current ~1100; goal ≥1250 not reached.** Per configuration: team-1 80k specialist `42159b07ffa5` **37-28 (57%) over 65 games**, peak 1184, final 1118 — milestones **1050 and 1100 verified and frozen** for it (57 rated games at the time); deeper GRU (128×2, fresh, 49k battles, team 1) `abe0892d879b` **13-20 over 33 games**, peak 1218, final 1062; older configurations as in the table below. The peak of 1218 came during an 8-8 run and was not sustained (the registry's credibility rule needs ≥50 rated games at or above the threshold), so **no ≥1200 milestone is frozen**.

**Honest assessment:** every configuration tried sits at a 40–60% ladder win rate; ≥1250 sustained needs ~70%. Seed-to-seed variance is large (a replicate of the best recipe scores 0.72 vs 0.90 against the heuristic on strong teams), so the best specialist is probably a good draw rather than a reproducible recipe. Reaching 1250 tonight would need a step change in play strength, not a variation on what has been tried; a lucky excursion is possible but would not be credible as achieved strength.

**Architecture fleet (local anchor: vs heuristic on strong teams, own team, 150 pairs):** deeper GRU 0.88 at 49k battles (but 39% on the ladder), warm 64-GRU Tauros team 0.91 at 30k, fresh 64-GRU 0.81 at 50k, wide GRU-192 0.66 at 37k, transformer-GRU 0.62 at 21k, warm 64-GRU Salazzle team 0.53 at 30k. The heuristic anchor did not predict ladder results (deeper GRU 0.88 → 39%).

## Where we are against the deadline (updated 19:15 CDT; target: end of 2026-09-28 local)

**Real ladder (account `ChampionsMC808583`, all games rated):** best rating **1184** (peak, mid-run), currently ~1077–1160 and moving with every session. Goal (≥1200) **not reached yet.**

| Ladder configuration (policy + team, temperature 1) | Rated games | W-L | Peak | Final |
|---|---:|---|---:|---:|
| Generic champion `da512c72a479`, random / searched team | 6 | 0-6 | 1011 | 1000 (floor) |
| Specialist team 2, 30k battles `74db66daca6a` | 12 | 5-7 | 1119 | 1057 |
| **Specialist team 1, 80k battles `42159b07ffa5`** (Clawitzer, Hisuian Arcanine, Snorlax, Eternal Floette, Hydreigon, Torkoal) | **26** | **16-10** | **1184** | 1077 |
| Specialist team 1, 150k battles `b3419dc96ad5` | 12 | 3-9 | 1184* | 1041 |

(*shared account rating at the time.) The 80k team-1 specialist is the best ladder configuration (61.5%, ±9 points). The 150k version of the same lineage went 3-9 against 8-3 (first 11) for the 80k one, even though it beats the 80k version 81% locally.

**Read this before trusting any local number.** Local head-to-head results against frozen agents are contaminated because those agents are members of the training opponent pool; they measure exploiting the pool, not strength. Evidence: the 150k specialist beats the 80k one locally but loses on the ladder. Only the ladder (and the heuristic as a weak anchor) are trustworthy. Local metrics are used only to reject clearly broken candidates.

**What 1200 needs (arithmetic):** against ~1100-rated opponents the rating settles where the win probability is 0.5, so ≥1200 sustained needs about a **65% win rate**; the best configuration is at ~61%. Touching 1200 by variance is plausible; sustaining it needs a real improvement. Several wins are opponents timing out (0–2-turn games, timer on), which count on the ladder but say nothing about play strength.

**Ladder loop:** `.cache/ladder-loop.sh` plays 3-game sessions back to back with the config in `.cache/ladder-config.json` (policy, team, temperature); every session records team, team hash, temperature and whether GRU memory is carried. Fixed today: the ladder adapter previously ran GRU policies with memory zeroed each decision (sessions before ~18:20 CDT); it now carries hidden state as in training. Temperature 0/0.5/1 made no local difference (0.810 vs 0.820), left at 1.

**Team specialisation works (local, strong-team yardstick; 200 pairs, opponent on searched teams; policy on its own team):**

| Policy @ team | vs frozen champion `da512c72a479` | vs its own 30k version | vs heuristic |
|---|---:|---:|---:|
| champion @ team1 / team2 (baseline) | 50.7% / 59.3% | — | 70.3% / 75.0% |
| GRU specialist team1, 30k | 65.0% | — | 90.2% |
| GRU specialist team1, **80k** | **77.0%** | 77.5% | 93.2% |
| GRU specialist team2, 30k | 78.2% | — | 82.5% |
| GRU specialist team2, **80k** | 75.7% | 64.7% | 86.8% |
| GRU one policy on all 4 teams, 80k (team1 / team2) | 72.3% / 69.5% | — | 74.0% / 91.5% |
| feed-forward, all 4 teams, 80k (team2) | 70.3% | — | 95.3% |

Single-team specialists are best and are still improving with battles (no plateau yet).

**Parallel architecture experiments (started 20:25 CDT, `arch-20260928/`):** the trainer and Node inference now support configurable width and depth (`--hidden`, `--depth`; new architectures `candidate-conditioned-gru-v2` / `candidate-conditioned-v4`; Python↔Node parity tested; all earlier checkpoints unchanged). Three fresh GRUs on team 1 (Clawitzer team) with the same opponent mix as the best specialist (heuristic 30% / self-play 30% / frozen pool 40%): `ar-gru-w192` (hidden 192), `ar-gru-w128d2` (hidden 128, two state layers), and `ar-gru-w64-fresh` (original size, fresh start — control for "fresh vs warm-started"). Snapshots at 50k and 100k battles. `replicate-20260928/rp-team1` (warm-started 64-unit GRU, same recipe as the best ladder specialist, different seed) runs alongside as a replication control. Wide models train at ~19–23 battles/sec vs ~32 for the small one.

**Training now:** round 2 (`round2-20260928/`): four GRU specialists warm-started from the champion, one strong team each (Salazzle/Talonflame/Sharpedo/Meowscarada/Rotom-Wash/Torterra; Tauros-Paldea/Skeledirge/Goodra-Hisui/Umbreon/Floette/Krookodile; Grimmsnarl/Arcanine/Azumarill/Aerodactyl/Meowstic/Salazzle; the team-1 Clawitzer team), against a heuristic-heavier mix (heuristic 50% / self-play 20% / frozen pool 30%) and a 12-team pool of coherent opposing teams found by a second team search (`teams/pool2-*.json`; against strong opposition the median generated team wins 17%, the best 73%). 60k snapshots exist; they continue to 120k. None has been on the ladder yet.

## Milestones, registry and scaling beyond 1200

1200 is the first milestone, not the design limit. `scripts/champions-registry.mjs` (registry under `runs/champions-vgc-2026-reg-mc/registry/`) keeps immutable, hash-keyed, read-only copies of every registered checkpoint and computes milestones from data:
- Milestones: 1000, 1050, 1100, 1150, 1200, 1250, 1300, 1400, 1500, then every additional 100 Elo automatically once a checkpoint's peak nears the next one (`milestones.json` holds the rules).
- **Credibility rule (not a one-game touch):** ≥50 rated games, final rating ≥ threshold, and the mean post-game rating of the last 25 rated games ≥ threshold. The first checkpoint to satisfy it is copied to `registry/milestones/elo-<T>/policy.json` (read-only) and never replaced. Below 50 rated games a rating at/above the threshold is shown only as *provisional*.
- Per checkpoint the registry records: SHA-256, architecture, parameter count, total training battles, opponent distribution and self-play %, training throughput, lineage parent, local scores vs random/heuristic (attached only if the evaluation report's checkpoint hash matches), scores against historical frozen agents, and the ladder ledger (games, rated games, W-L-T, first/peak/final rating, full per-game history ingested from ladder `summary.json` files by checkpoint hash).
- Commands: `register`, `local-eval`, `ingest-ladder`, `milestones`, `verify` (re-hashes everything), `status`, `show`. Registered so far: `864e8a541874` (the ladder checkpoint; 1011 final, 1035 peak, 5 games 1-4, only 2 with recorded rating changes, so provisional for 1000 at best).
- Promotion process (same for every milestone): local fixed-suite evaluation and historical-agent evaluation → register → supervised ladder session(s) → `ingest-ladder` → `milestones`. Ladder play stays a deliberate, user-authorised step; nothing in the training campaign plays on the public ladder.
- After a verified ≥1200: freeze it, continue from the strongest suitable lineage with the identical promotion process, then set the next milestones; scaling stops only when extra training no longer moves ladder rating or local compute dominates.

**Training-method extension points** (added one at a time, each validated locally then on the ladder): the trainer already isolates architecture (`--architecture`: feed-forward and GRU; entity attention, larger models are new `Model` variants sharing the export/Node-inference contract), opponent (`--training-opponent`; next: a per-battle opponent mixture including historical frozen agents drawn from the registry pool and league/population play, chosen deterministically from seed and battle index so worker-count invariance holds), objectives (reward-only PPO today; auxiliary simulator-derived heads and opponent/belief modelling attach to the shared representation), and search (a rollout wrapper around `Policy.choose`). Nothing about them is keyed to a rating target.

## Latent-reasoning monitoring (every ~10 minutes while the campaign runs)

`scripts/analyze-battles.mjs` (wrapper `scripts/run-latent-analysis.sh`) plays fresh battles each pass (seed block advances from 4,000,000,000, disjoint from training and evaluation) and measures behavioural proxies: win rate vs heuristic; agreement with the heuristic's own action; **causal memory ablation** for GRU (zero the hidden state at every decision: win-rate delta and action-distribution change); critic foresight AUC by game phase; and situational tactics from the simulator request (Protect vs HP, switching at low HP, first-turn support/speed control, focus fire, Mega use), for the learner and the heuristic, against untrained same-architecture weights as the chance control. Results: `runs/champions-vgc-2026-reg-mc/analysis/latent-*.json` and a one-line-per-pass `latent-reasoning.jsonl`. These are proxies for strategic structure, not proof of reasoning; 120 games per policy per pass gives roughly ±0.09 win-rate noise, so only trends across passes count.

First pass (analysis #0, 60 pairs per policy):
- Not heuristic mimicry: untrained weights agree with the heuristic on 19–21% of decisions and win 10%; the ~50,000-battle policies win ≈47–53% while agreeing on only 36–43%.
- Critic foresight AUC rose from chance (0.42–0.52) to ≈0.70 early and ≈0.75–0.81 mid-game.
- **GRU memory is not yet causally important:** zeroing memory changes action probabilities by only 5–6% (total variation) and win rate by −0.03 to −0.01, i.e. nothing measurable. The claim that recurrence is unlocking reasoning is not supported yet.
- Learners choose two *different* foes far more often than the heuristic does (same-target rate 0.00–0.33 vs ≈0.60); 0.004 for one policy looks like a fixed "each attacker hits its opposite foe" habit, a positional shortcut rather than reasoning. Watch for it.

## Checkpoint-preservation note

Resuming the two 20,000-battle seed-20260937 runs in place overwrote their `policy.json`/`policy.pt`; only the evaluation reports and hashes (FF `11d0c0b964a9…`, GRU `66ac9cd5943e…`) survive, not the files. The 5,000-battle snapshots are intact. The campaign script now snapshots every stage as `policy-<stage>.json/.pt`, and every snapshot should be registered.

## Throughput infrastructure (done; PPO semantics unchanged)

Before: one Node simulator process + one Python learner, 43–50 battles/sec (39–41 GRU). Host: Apple M5, 10 cores (4 performance + 6 efficiency), 16 GB. Reports: `reports/champions-vgc-2026-reg-mc/throughput-benchmark-*.json`; driver: `agents/benchmark_training_throughput.py`.

**What changed**
- `train_champions.py --workers N`: N persistent simulator processes; every rollout batch is played entirely under one frozen policy version (workers echo the version back and the learner rejects any mismatch), then PPO runs, then version N+1 is sent. `--concurrency C` runs C battles in flight per worker. `--legacy-collect` keeps the original single-worker path as the reference.
- Battle RNGs derive from (batch seed, attempt index), so results do not depend on how battles are split across workers. **Verified bit-for-bit:** identical final weights (SHA-256 of weights) for legacy, 1, 3 and 4 workers, concurrency 1 and 3, Torch threads 1/2/4, and resumed-vs-uninterrupted runs, for both feed-forward and GRU (`agents/test_champions_ppo.py`, 9 tests).
- Per-experiment files: each run writes `<output>.ledger.json` and `<output>.status.json`; the shared `experiment-ledger.json` is now frozen history (last written 19:37 UTC) and no longer touched, so independent seeds/architectures can run concurrently. Evaluations no longer write a shared ledger either (each report carries its own counts; optional `CHAMPIONS_EVAL_LEDGER`).
- Policy weights go to workers as exact base64 float32 (Node widens to the same doubles the JSON path produced); the deployable `policy.json` is written every `--checkpoint-seconds` (30 s), at stop and at completion, while the resumable `.pt` state is written after every update. SIGTERM stops gracefully (verified: final JSON matches status, 0 aborted).
- PPO minibatch inputs are converted to float32 arrays once per batch instead of once per minibatch (values unchanged): PPO 3.3 → 1.9 ms/battle.
- `EVAL_JOBS=N node scripts/evaluate-champions-vgc.mjs …` shards pair ranges across processes; the merged report is identical to the serial one (verified on 200 pairs: scores, intervals, value metrics, per-pair rows, diagnostics) and about 3× faster with 5 jobs (11.3 s → 3.8 s).

**End-to-end training battles/sec** (1,600–2,400 battles per cell, heuristic opponent, batch of 8 battles per PPO update as before; run-to-run noise ≈ ±10%)

| Workers | Concurrency 1 | Concurrency 2 | Concurrency 4 |
|---:|---:|---:|---:|
| legacy path | 50 | — | — |
| 1 | 56 | 56 | 48 |
| 2 | 83 | 81 | 61 |
| 4 | 104 | 100 | 74 |
| 6 | 106 | 101 | 72 |
| 8 | **116** | 107 | 71 |

GRU (concurrency 1): legacy 43, 1 worker 52, 4 workers 92, 6 workers 93, 8 workers 85. Concurrency above 1 does not help because the simulator is single-threaded CPU-bound; more processes is the lever. Torch threads 1/2/4 gave 92.5/93.4/93.6 battles/sec (no effect on a 55k-parameter model), so the default is now 1 thread to avoid oversubscription.

**Single experiment: ≈2.3× (feed-forward) and ≈2.1× (GRU) over the legacy path on the same code, ≈2.6× over the 45/sec quoted earlier.**

**Concurrent independent experiments** (each with its own ledger; feed-forward and GRU mixed; wall-clock including ~2 s startup): 3 experiments × 2 workers 156 battles/sec aggregate, **4 × 2 workers 163.5**, 4 × 1 worker 156, 5 × 2 workers 121 and 2 × 6 workers 75 (oversubscribed). Best aggregate ≈ **3.5×** the ~45/sec baseline.

**Component measurements** (single worker, per CPU-second unless noted)
- Raw simulator only (no encoding/inference): ≈109 battles/CPU-sec (≈9 ms/battle) — about 74% of worker time.
- Observation encoding: ≈10,000 encodes/CPU-sec (≈13%). Policy inference plus the heuristic opponent, in JS: ≈10,000 decisions/CPU-sec (≈13%).
- With 6+ workers per-worker rates fall (encode ≈7,000/s, simulator ≈71 battles/CPU-sec) because 6 of the 10 cores are efficiency cores.
- Serial learner cost per battle: PPO 1.9 ms, tensor prep 1.2 ms, policy serialization 0.07 ms (was ≈1.8 ms as JSON), IPC send 0.03–0.18 ms.
- Python round-trip overhead beyond worker compute (summed): 2.9 s per 1,600 battles with 1 worker, 7.6 s with 6 workers.

**Not adopted, with measurements**
- *Central batched Torch inference:* Torch on CPU reaches 28,600 decisions/s at batch 1 and 313,000/s at batch 256 with no IPC, but simulation needs a decision round-trip per choice, and the in-worker JS inference already costs only ≈13% of worker time (≈100 µs/decision). Moving it to Python would add a process round-trip per decision. Not worth it at this model size; revisit only if the network grows by ~100×.
- *MPS:* PyTorch now reports MPS built and available in this shell (the earlier "unavailable" note came from a restricted process), but a PPO step takes 1.72 ms on MPS vs 0.47 ms on one CPU thread (3.7× slower), and batched inference only overtakes CPU at batch 256 (440k vs 314k decisions/s) — a batch size this trainer never forms. Kept on CPU.
- *Double-buffered rollouts inside one experiment:* overlapping PPO with the next rollout would collect that rollout with policy N while N+1 is being trained (one-version-stale), which violates the on-policy guarantee. Instead the idle simulator time during PPO is filled by running independent experiments concurrently (above).
- *Larger rollout batches:* batch 16/32/64 raised throughput only 10–15% (100/104/105 vs 91 battles/sec) and change the PPO update cadence, so they stay a separate hyperparameter experiment, not an infrastructure change.

**Recommended settings:** one experiment alone, `--workers 6` to `8`; 3–4 experiments at once, `--workers 2` each; `--torch-threads 1`; never exceed ≈10 simulator processes in total.

## `maybeTrapped` handling

- `trapped: true` removes switch actions.
- `maybeTrapped: true` retains switch actions and is present in candidate features.
- A rejected uncertain switch is counted as `hiddenTrapReveal`; the updated Showdown request is consumed and the policy chooses again. These are expected events (0–4 per 5,000 training battles, 0–1 per 1,600 evaluation battles), not errors.

## Experiment progression

| Run | Training battles | vs random | vs heuristic | Decision |
|---|---:|---:|---:|---|
| Historical fresh nonlinear v2 (5k) | 5,000 | 82.5% | 34.3% | Frozen; policy useful, critic invalid |
| Feed-forward v3 (5k, two seeds) | 5,000 | 72.1 / 73.9% | 26.9 / 21.3% | Learning confirmed |
| GRU v1 (5k, two seeds) | 5,000 | 68.1 / 70.3% | 19.1 / 22.4% | Inconclusive vs control |
| Feed-forward v3 (20k) | 20,000 | 84.3% | 35.6% | Scaling helps |
| GRU v1 (20k) | 20,000 | 84.5% | 39.9% | Best so far; needs a second seed |

## Next actions

1. ~~Parallel training/evaluation infrastructure~~ — done; see above.
2. Campaign `runs/champions-vgc-2026-reg-mc/campaign-20260928/` (2 feed-forward + 2 GRU, two seeds, 2 workers each, ≈160 battles/sec aggregate) is at stage 2 of 2 (100,000 battles); each stage is snapshotted, evaluated (`EVAL_JOBS=5`) and should be registered. Then: add the historical-frozen-agent opponent mixture (and score each new checkpoint against the pool), because heuristic-only training will plateau near parity with its opponent.
3. Later experiments, one change at a time: heuristic-plus-self-play opponent mix, entity attention, auxiliary tasks, search.
4. Re-attempt ladder evaluation only with a frozen checkpoint that is clearly stronger against the local heuristic; keep the 1200 Elo target.

## Update 2026-09-29 (afternoon): human-behaviour opponent, view fix, ladder-side search, GitHub

- Goal is now 1350 real Elo ("improve human local players with a variety based on our matches").
- New `human` opponent kind (`humanAction`, rates from `scripts/human-behaviour.py` over ~500 own ladder battles); rating-band styles and focus-fire rates are computed (`human-behaviour.json` -> `bands`) but not yet sampled per battle. Humans switch ~4-10%/slot-turn almost independent of HP; Protect ~12-14%.
- `VisibleState` roster bug found and fixed behind `CHAMPIONS_VIEW=2` (opposing fainted count wrong in 64% of states under v1). Control policy unchanged locally under v2 (0.857 vs 0.867 vs heuristic).
- Training arms running: `humanclimb4-20260929` (v1 view) vs `humanclimb5-20260929` (v2 view), GRUs warm-started from `humanclimb2/hd-team1/policy-60000.json`, mix human=0.55/heuristic=0.05/selfplay=0.2/pool=0.2. Compare both against the `human` baseline on held-out human teams.
- Ladder-side search built (`src/reconstruct.ts`, `src/ladder-search.ts`, `LADDER_SEARCH=1`): paired eval of the control vs the human-rate opponent, held-out teams, 150 games: 0.82 -> 0.90 (+0.08, CI 0.007-0.153), 1.35 s/decision. Not yet played on the ladder.
- Ladder: new account 52-59 over 111 games (genuine 44-59); 15 turn-1 opponent concedes (all wins), 8 early-forfeit wins on the new account. Total simulator training battles so far about 5.4M (ledger sum, approximate); 506 unique real ladder battles.
- Code and docs pushed to https://github.com/Chrispyontheoutside/demo-pokemon-GRU (runs/, .cache/ and checkpoints are not in the repo). See `CHAMPIONS.md` for usage.
- Next: sample rating-band styles per battle in `humanAction`; evaluate arms 4 vs 5; play the search-enabled control on the ladder in a bounded session; keep the 1250/1350 watcher running.

## Update 2026-09-29 (evening): arms compared, preview search, ladder queue

- Per-battle human styles (rating band, rate jitter, focus-fire preference, 2-15% sloppy picks) are now sampled by `humanAction`.
- Arm comparison on held-out human teams (120 pairs, +-0.05 noise), vs heuristic / guarded / human: control(v1) 0.879 / 0.871 / 0.863; h4 (human-opp training, v1 view) 0.854, 0.812 heuristic and 0.829, 0.796 human (no gain); **h5v2 (same training, corrected view) 0.917, 0.887 heuristic and 0.875, 0.850 human**. Consistent ~+5 pts over the v1 arms on both seeds; local benchmarks are near saturation, so the ladder must decide.
- Ladder-side search now also searches team preview (lead choice): rate the top-12 distinct lead sets over 3 determinizations x 3 full-game rollouts against the human model (~1 s). Local paired eval vs the human model, 200 games: +2.0 (CI -3.4 to +7.4) with preview search, +1.0 without; the earlier +8.0 (150 games) was a different sample. Search gain is real but small and not resolvable locally.
- Ladder: control with search (`registry/search/policy-search.json`, distinct hash) is 4-4 after 8 games; queue order now: search-control to 40 games, h5v2-team1a plain (046ed1c564a3) to 60, h5v2-team1a + search to 60. All with CHAMPIONS_VIEW=2. Watch `python3 <scratchpad>/sv.py`-style tallies via the registry `ingest-ladder`.
- Training: `humanclimb6-20260929` (v2 view, human styles, warm-start from h5v2-team1a) running, 2 seeds.
- Still far from 1350: best real 1229 final / 1273 peak, no sustained milestone.


**Compact transformer challenger (2026-09-29 14:39 CDT, running):** User authorized pursuing the non-GRU transformer experiment. `transformer-20260929/run.py` is running as PID 71480 (trainer PID 71517), protected from idle sleep by caffeinate. Fresh feedforward transformer: 2 layers, width 64, 4 attention heads, 13 state tokens, 86,082 parameters. One simulator worker and one Torch thread. Automatically trains to cumulative 20k / 60k / 100k completed battles, saves immutable stage snapshots, and evaluates each against random / heuristic / guarded opponents using 200 paired seeds, the fixed team-1 learner, and 60 held-out opposing team packs. Frozen runtime, training team packs, human behavior model, historical opponent policies, and the 80k GRU control are hash recorded in `transformer-20260929/manifest.json`. The initial Python/Node inference parity check passed; the live status showed 1,368 completed battles at 21.1 battles/sec with no truncated or aborted battles. The GRU control's fixed evaluation scored 0.980 vs random, 0.858 vs heuristic, 0.833 vs guarded. Live process state: `transformer-20260929/progress.json`; training counters: `transformer-20260929/policy.status.json`; results: `transformer-20260929/REPORT.md`. This compares a fresh challenger with an existing GRU incumbent whose training history differs; it does not isolate architecture as the cause of any difference. Local evaluation precedes a separate rated ladder decision.

## Update 2026-09-29 (night): h6 result, milestone spike, ladder tally

- `humanclimb6` (v2 view + per-battle human styles, warm-started from h5v2-team1a) at 60k: heuristic 0.85/0.84, guarded 0.87/0.87, human 0.85/0.84 vs h5v2-team1a 0.88/0.91/0.91 on the same fresh seed (150 pairs, +-0.05). More human-opponent training does not help locally; h5v2-team1a stays the best local candidate.
- The 1250 watcher fired earlier (12:06 CDT): a 2-turn win (opponent concession) took the account 1244 -> 1273; last-25 mean 1136, rating since back to ~1100. Evidence in `milestones-live/elo-1250-20260929T120638/`; screenshot failed (no Screen Recording permission). This is a spike, not a milestone; nothing is frozen at 1250.
- Ladder, search-enabled control (`registry/search/policy-search.json`): 10-9 after 19 games, rating ~1101; 105 searched decisions (19 preview), ~1.4 s each, no errors.


**Transformer check (2026-09-29 15:43 CDT):** 20k and 60k snapshots completed evaluation. At 60k, score vs heuristic 0.780 [0.738, 0.820], vs guarded 0.810 [0.767, 0.850]; GRU control 0.858 [0.812, 0.897] / 0.833 [0.790, 0.873]. Training stopped at 69,840 completed battles on a rollout JS/Torch log-probability assertion (one of 32 values, absolute difference 0.000496; tolerance atol=rtol=0.0001). Restarted the existing driver from its saved checkpoint without changing code or tolerances; startup parity passed and training advanced to 71,856 completed battles at 39.6/sec. PPO used 71,840 battles; the failed batch accounts for 16 completed battles not used for PPO. The 100k target and subsequent fixed evaluation remain scheduled by the driver. This numerical failure is unresolved; a successful restart does not establish its cause.


**Active goal: 1350 Elo sustained over 50 battles (2026-09-29).** `scripts/audit-1350.py` now verifies a consecutive window on one account/checkpoint/team/temperature, every post-battle rating >=1350, with server rating messages matched to saved logs. Current audit: no qualifying window; avin-owes-me-25 latest 1153. `coverage-1350-20260929` is running a 64-GRU adaptation from h5v2-team1a on corrected view v2, with 1,816 legal synthetic team variants from 458 own training-source battles and 80 later own battles held out before fitting team frequencies and human behavior. Existing scripts now accept a separate raw output path and room-restricted behavior fit. Snapshots/evaluations at 20k and 60k new battles; 200 paired seeds against random/heuristic/guarded/human opponents. The parent may have seen held-out data previously; this limitation is recorded. No automatic ladder promotion. Existing queue is finishing search-control (38/40 recorded games on this account), then testing h5v2 plain and search. Transformer experiment remains live toward 100k.


**Transformer experiment completed:** 100k fresh compact-transformer battles, scores random 0.970 [0.953,0.985], heuristic 0.755 [0.710,0.797], guarded 0.815 [0.772,0.855]. GRU control heuristic 0.858 / guarded 0.833. Transformer not promoted; recorded counterfactual evidence favors retaining GRU while the coverage adaptation is evaluated. Exact reports and frozen snapshots are in transformer-20260929/. Active 1350-over-50 objective remains unmet.


**Coverage adaptation first result (20k new battles):** GRU parent vs adapted scores: heuristic 0.890 -> 0.9025, guarded 0.9225 -> 0.9050, empirical-human 0.8950 -> 0.8975 (200 paired seeds each; confidence intervals overlap). No convincing gain, so no ladder promotion from this snapshot. The run is confirmed live toward 60k additional battles. Driver stage labels inherited a transformer prefix from the reused runner; the model manifest and checkpoints specify a GRU. Label spelling corrected in the report/source, with compatibility normalization on restart; the live process may write the old spelling until its final result is normalized. Ladder audit latest 1163 over 159 rated games on the current account, no qualifying 1350/50 window. Goal remains active.


**1350 goal continuation: search memory correction.** Found in shared searchDecision that each root candidate was applied without advancing the learner GRU through the root observation. Fixed source to carry prediction.hidden into accepted cloned branches. TypeScript compiled successfully to an isolated runtime, leaving public ladder dist unchanged. Started old/fixed paired search evaluation (60 games each, same seeds/teams/policy/settings, v2 view, 2 workers each), PIDs 79946 / 79947, manifest and per-seed output under search-memory-1350-20260929/. Both runtimes fit opponent data only from 458 training-source rooms. Coverage adaptation still confirmed live toward 60k. Goal remains unmet; no promotion claimed.


**Search correction comparison and rated trial queued:** 60 paired seeds, old search .900, fixed search .967, plain .933 with exactly matching plain outcomes. Fixed-old +.0667, approximate paired 95% CI [-.0122,+.1455], inconclusive. Extension to 200 total paired seeds running (140 additional), PIDs 80382/80383. Fixed search variant 2492d5913582 registered and queued after the current h5v2 plain-GRU trial, 60 rated games in isolated fixed runtime; original h5 search trial retained afterward. Dispatcher updated for per-account deduplicated rated counts and runtime selection, restarted as PID 80493 while preserving the active ladder client PID 80261. Latest audited Elo 1233; goal 1350 over 50 remains unmet. Coverage adaptation confirmed live at 52,216 additional battles toward 60k.


**Field-header correction experiment:** Found that legacy packState writes opponent Reflect/Light Screen/Tailwind/Safeguard at 32..35 before overwriting them with the first Pokemon feature block. Added opt-in CHAMPIONS_FEATURES=3: six VGC field effects per side in global slots 20..31, replacing legacy hazard flags. Controlled encoding diagnostic: legacy changes no slots when the four effects are added; v3 changes 26/27/29/30 and leaves Pokemon features identical. Compiled isolated runtime, started fields-v3-1350-20260929 PID 80947, 64-GRU warm-start from h5v2 parent, stages20k/60k, same clean source split and held-out suite. Startup inference parity passed. Coverage adaptation completed60k: parent/adapted heuristic .890/.8925, guarded .9225/.900, human .895/.9075; no convincing gain, not promoted. Search200-seed extension remains running; current ladder rating audited1160. Goal remains active and unmet.


**Search200-seed comparison complete:** plain .960, old search .930, corrected search .950. Plain outcomes match all200 paired seeds. Fixed-old +.020 (approx95%CI [-.0238,+.0638]); fixed-plain -.010 ([-.0493,+.0293]). Neither improvement is established. Corrected search remains an experimental rated trial, not a demonstrated stronger policy. Full per-seed evidence and comparison-200.json are saved. Field-header v3 adaptation continues.


**Visible boost correction (feature v4):** Found monFeatures ignores pokemon.boosts on opposing VisibleMon entries and evasion slot40 overlaps species hashing. Opt-in v4 reads opposing observed types/boosts; packs seven boosts at33..39; resets boosts on real switches and handles Haze clear-all. Isolated boosts-v4-1350-20260929 compiled and is confirmed running, PID81736, 10,152 new battles; startup parity passed. Controlled live-view diagnostic changed slots449/455 for opposing attack/evasion, preserved species hash, and clear-all restored attack0. Fields-v3 first20k scores heuristic .8625, guarded .8950, human .8775 vs parent .890/.9225/.895; no promotion. Also corrected cross-side nickname collisions in human-behaviour.py HP tracking: fitting the same458 training rooms produces3496 rows and changes5/9 conditional rate cells. Side-aware rates saved separately for future use; active frozen experiments unchanged. Goal remains active and unmet.


**Setup-aware opponent and v4 rated trial:** Audit of458 training rooms:296/3258 human move events (9.1%) are setup/field-control. Fitted setup rates conditional on820 rows belonging to Pokemon with observed setup moves; names limited to19 observed moves, held-out80 rooms excluded. New pilot respects move availability/current fields/capped boosts and side-aware HP. Rollout audit100 games per pilot: selected setup actions legacy4/771 (0.52%), new100/785 (12.74%); learner wins87/88, so increased strength is not established. Setup-human-v4 adaptation from the frozen v4@20k checkpoint is confirmed running PID82953, 32,176 new battles, parity passed, stages20k/60k. Registered plain v4@20k ladder variant c511fb10a630; queued60 rated games in its frozen runtime with explicit feature4. Current old h5v2 trial is6-9 after15 rated games, capped at24 to allocate evaluation to the corrected-input candidate. Dispatcher83347 confirmed live; current client83186 preserved. The corrected-search trial remains afterward. Goal remains active and unmet.


**Corrected-feature runs completed:** fields-v3@60k heuristic .8625, guarded .9000, human .9175 (parent .890/.9225/.895); boosts-v4@60k .885/.895/.8975 (v4@20k .900/.9125/.910). No decisive gain from longer training. The registered v4@20k trial remains the selected corrected-input candidate. Setup-aware adaptation@20k scores .905/.910/.915 vs its parent .900/.9125/.9125 on the new pilot, no convincing improvement; confirmed live toward60k. Latest audited rating1125, no1350-over50 window.

## Contextual opponent integration — 2026-09-29

- Goal remains 1350 sustained over 50 rated battles. Last audited current account: 184 rated battles, latest 1087; no qualifying streak.
- Setup-aware adaptation finished 60k: heuristic .877, guarded .900, human .9225; parent .900/.9125/.9125. Human-pilot gain accompanies regressions elsewhere, so no promotion.
- Corrected behavior fitting to use turn-start HP. Added opt-in public-context opponent forecast and routed public views through rollout/evaluation/search callers. Isolated TypeScript compilation succeeded; shared ladder runtime untouched.
- Context forecast held-out NLL .87163 versus 1.00840 bucket baseline. Initial 100-pair parent evaluation launched in isolated runtime (PID 85749). Category forecasting improvement is not Elo evidence; extraction count difference remains to audit.

Context parent screening completed: 800 battles, zero truncations/aborts; random .985, heuristic .870, guarded .905, contextual human .920. No evidence yet that the contextual opponent is stronger; audit extraction differences before a costly adaptation run.

## Complete-log correction and contextual adaptation

The older behavior extractor kept incomplete early duplicate logs. Explicit raw-source selection restores 395 net decisions; both extractors now yield 3891 on 458 rooms. Rebuilt behavior rates and launched frozen contextual GRU adaptation at 20k/60k stages. Latest audited Elo 1110 after185 rated games; goal unmet.

Contextual adaptation confirmed live (driver86085, trainer86168): 2352 completed battles at29.75seconds. Corrected-input ladder checkpoint c511fb10a630 is active; latest account rating1132 after186 rated battles.

## Contextual adaptation first checkpoint

20k completed and evaluated on200 paired seeds: parent heuristic .900, guarded .9125, contextual human .885; adapted .8725/.9025/.900. Paired bootstrap comparison saved in human-context-1350-20260929/comparison-20000.json. No convincing broad gain; no promotion. Driver86085 and trainer86638 confirmed live for60k stage. Latest audited Elo1115 after189 rated games; goal unmet.

## Live training and rated loss collection

Contextual trainer86638 confirmed live:29392 total completed adaptation battles. Corrected team-source selection to prefer full duplicate snapshots. Audit finds no additional revealed moves in the original538-team dataset, so this fix does not revise its current contents. New extraction includes574 source battles (36 additional); current frozen training unchanged. Two corrected-input rated losses recorded in human-context-1350-20260929/rated-loss-cases.json for future matchup diagnostics: Fake Out interruption and double attacks into Protect followed by losses to boosted faster attackers. These are observations, not proofs of optimal alternative actions.

## Refreshed matchup screening

574-source dataset reconstructed with1960 train packs and79 unique held-out packs from80 source rooms. Source-room and pack disjointness confirmed. Parent vs context20k on100 paired seeds: heuristic .850→.875, guarded .820→.890, contextual human .945→.875. Mixed transfer, no promotion. Data-refresh-20260929/comparison.json stores paired bootstrap differences. Contextual trainer86638 confirmed live at43800 completed battles; goal remains unmet.

## Matched recurrent architecture comparison

Launched fresh attention encoder plus GRU memory versus fresh MLP-GRU control. Both use seed20261351, featurev4, identical updated1960-team training data, contextual opponent/mix/PPO settings, one rolloutworker/oneTorchthread, and20k/60k/100k stages. Attention uses one64-wide layer, fourheads,13tokens. Evaluation uses200 paired seeds and79 unique packs from80 held-out source rooms. Frozen runtime/source/input hashes saved per manifest. Drivers87470/87477 and trainers87525/87528 confirmed live. Existing contextual warm-start adaptation continues separately. This comparison keeps temporal memory and matches training history; no rated promotion yet.

## Contextual60k completed and queued for rated comparison

Original held-out scores parent→60k: heuristic .900→.910, guarded .9125→.9125, human .885→.9075. Refreshed screening: heuristic .850→.875, guarded .820→.900, human .945→.915. Evidence mixed, but broad recovery versus20k supports a rated trial. Frozen contextual60k variant 7d0c790aedb4 queued for60 games following corrected-input candidate, capped at24. Architecture comparison remains live. Latest audited account Elo1135 after194 rated battles; no1350 streak.

Matched architecture experiment inputs audited: identical non-architecture PPO arguments, seed, training/evaluation team contents and policy pool. Both trainers confirmed live. Runtime throughput and completed-battle counts saved in architecture-comparison-progress.json; no architecture-strength conclusion yet.

## Matched architecture20k results

Fresh MLP-GRU vs attention-GRU under matched recipe: heuristic .835 vs.745, guarded .870 vs.7625, contextual human .845 vs.7825. Paired bootstrap results in architecture-comparison-20000.json; one training seed limits architecture generalization. Attention underperforms at20k; both runs continue toward60k/100k rather than promoting either fresh checkpoint. Latest audited Elo1158 after197 rated battles; no1350 streak.

## Ladder queue preserves qualifying goal streaks

Auditor now reports current qualifying streak and exact checkpoint/team/temperature. Queue uses that verified state to prioritize the current qualifying configuration and extend its trial until50 qualifying battles, and stops once the independent audit proves success. Ordinary trial caps still apply below1350. Game counting now distinguishes temperature. Replaced daemon83347 with88649 while leaving active online client88567 running. New daemon confirmed live and waits for the same existing client; no duplicate ladder client launched. Current audited Elo1180 after198 rated battles; zero qualifying streak, goal remains active.

## Fresh GRU control60k completed

At60k: heuristic .855, guarded .8375, contextual human .870. Versus20k: heuristic +.020, guarded -.0325, human +.025; paired intervals saved in matched-gru-20260929/comparison-20k-60k.json. No decisive promotion case. Control continues toward100k (trainer89617); attention trainer88426 remains live toward60k. Latest audited Elo1199 after201 rated games, zero qualifying streak.

## Bulk-spread team screening

Current team has maximumSpeed on Curse Snorlax and Torkoal. Created four legal variants preserving species/moves/items. Snorlax-defense variant also gives Torkoal HP32/SPA32/DEF2 Modest; Snorlax gets ATK32/DEF32/HP2 Impish. Original→variant scores on100 paired seeds: heuristic .860→.865, guarded .810→.845, human .875→.905. Screening gains are small and include selection over several variants; no promotion. Fresh200-seed confirmation launched. Frozen architecture runs and live ladder unchanged.

## Bulk team fresh-seed confirmation and rated trial

200 fresh paired seeds: original→bulk heuristic .845→.870, guarded .8825→.900, human .8725→.8875. Guarded/human paired intervals include zero; modest transfer, not Elo proof. All3200 confirmation battles completed. Frozen bulky team queued for60 rated games using unchanged c511fb10a630 checkpoint and its original featurev4 runtime after current24-game trial; contextual60k follows afterward. Team change kept separate from policy change. Latest audited Elo1138 after203 games, goal unmet.

## Matched recurrent architectures at60k

MLP-GRU vs attention-GRU: heuristic .855 vs.7625; guarded .8375 vs.8275; contextual human .870 vs.850. Attention closed most guarded/human gap since20k but still trails substantially against heuristic. Paired bootstrap intervals in architecture-comparison-60000.json; one training seed. Both continue to100k (trainers89617/90236). No fresh model promotion. Latest audited Elo1161 after204 rated games; goal unmet.

## Fresh GRU100k terminal result

Control driver87477/trainer89617 finished100k and disappeared after successful completion. Final heuristic .7975, guarded .8125, contextual human .8125; regression from60k. Paired60k→100k intervals saved in matched-gru-20260929/comparison-60k-100k.json. No promotion or restart. Attention trainer90236 remains live toward100k. Current online client90625 confirmed live after original24-game sample; verify bulk configuration from its saved summary when available. More training under this recipe has not produced a stronger final checkpoint.

## Final GRU temperature diagnostic

100 fresh paired seeds: temperature1/.5/0 human scores .770/.825/.835; heuristic .815/.810/.810; guarded .835/.830/.830. Lower temperature helps against contextual pilot without recovering other regressions. Paired intervals saved in temperature-100k-20260929/comparison.json. No promotion. Bulk team68311aec9888 now has its first rated win recorded on unchanged c511 policy; audited account1114 after208 games. Attention trainer90236 remains live at81992 completed battles.

## Expert-rating coverage audit

Saved opponent-rating-coverage.json: original458 human training rooms have median1101 and zero opponents at1300+. All574 extracted source rooms contain only two1300+ opponents and none1350+; current refreshed80-room held-out set has one1300+ opponent. Therefore reconstructed-team volume does not supply expert human decisions at the target rating. This limits the empirical pilot as a proxy for1350 play. Bulk team is2–1 on first3 rated games; latest account1111 after210 games. Attention trainer90236 remains live.

## Search-based synthetic adversary screening

30 paired seeds on79 held-out reconstructed human team packs: opponent plain policy scored .0333 versus .3667 with rollout search against current c511GRU on bulky team. This is a privileged local teacher: full cloned synthetic battle state, same learned policy models future play,10 root candidates ×4 rollouts ×4-turn horizon, greedy searchQ with prior tie-breaking. It is not a rated Elo estimate. Extension to100 pairs launched to confirm stronger opposition before adding a training route. No online inference changes.

## Architecture comparison complete; synthetic adversary confirmed

At100k, attention-GRU vs matchedMLP-GRU: heuristic .790 vs.7975, guarded .8775 vs.8125, human .8925 vs.8125. Paired intervals in architecture-comparison-100000.json; one training seed, final-checkpoint comparison does not establish superiority over every earlier GRU checkpoint. Frozen attention variant 659d0a8a9a0e queued for60 rated games after bulk-team trial, original training team and temperature1. Both architecture drivers successfully terminal. Search opponent confirmed on100 paired held-out-team seeds: plain .08 vs search .36, delta .28, paired95 interval [.19,.37]. Full synthetic-state privilege is documented; no Elo inference. This is a candidate stronger local training opponent. Latest audited Elo1140 after213 games; goal unmet.

## Search opponent PPO integration and400-stage pilot

Implemented training-only DirectGame search route producing standard public learner episodes, configured frozen search teacher via environment. Added learning-rate CLI with prior3e-4 default retained; pilot uses6e-5. Isolated runtime compilation succeeded. Warm-started c511weights on bulky team,1960 training variants, mix40% search/20% human/20% guarded/10% selfplay/10% pool.400 battles completed and200-seed evaluation: heuristic .870→.865, guarded .900→.8975, human .8875→.895; no decisive gain. Driver92347 and trainer92552 confirmed live toward4000, then12000. Latest audited account1174 after217 rated battles; goal unmet.

## Search adaptation repair — 2026-09-29 23:28 UTC

Original search adaptation stopped after1720 completed games on whole-action retry exhaustion in rollouts. Its runtime remains frozen. A separate search-adapt-joint-20260929 resumes checkpoint/optimizer/counters using whole joint action rejection; confirmed live and past stopping count. Parent and400 checkpoint probes completed200 pairs under repaired runtime: learner scores against search teacher .760/.730; no demonstrated adaptation gain. Attention-GRU100k probe started on same200 seeds and bulk team; comparison has different training budget/initialization, and teacher models each learner current policy. Latest goal audit221 rated on current account, Elo1119, zero1350 streak.

## Attention search comparison — 2026-09-29

Completed200 paired seeds versus parent on same bulk team; different training histories and teacher forecasts each learner actual policy. {"plain": {"parentLearnerScore": 0.94, "attentionLearnerScore": 0.925, "delta": -0.015, "pairedBootstrap95ci": [-0.065, 0.035]}, "search": {"parentLearnerScore": 0.76, "attentionLearnerScore": 0.625, "delta": -0.135, "pairedBootstrap95ci": [-0.21, -0.06]}} No Elo inference; preserve rated attention trial.

## Search adaptation4000 — 2026-09-29

Repaired run completed cumulative4000-stage training and standard held-out evaluation; now training toward12000. Frozen4000 checkpoint started200-pair search-teacher comparison under same runtime/seeds/team as parent. {"gru-parent": {"random": 0.9775, "heuristic": 0.87, "guarded": 0.9, "human": 0.8875}, "gru-4000": {"random": 0.98, "heuristic": 0.885, "guarded": 0.905, "human": 0.9125}}

## Completed4000 teacher comparison

{"pairs": 200, "direction": "4000 learner minus parent", "limitation": "Frozen teacher policy models current learner; synthetic privileged search, not Elo.", "opponents": {"plain": {"parentLearnerScore": 0.94, "adaptedLearnerScore": 0.95, "delta": 0.01, "pairedBootstrap95ci": [-0.025, 0.05]}, "search": {"parentLearnerScore": 0.76, "adaptedLearnerScore": 0.75, "delta": -0.01, "pairedBootstrap95ci": [-0.08, 0.06]}}} Standard held-out paired intervals also include zero for every opponent. No4000 ladder promotion; continue12000 stage before further selection.

## Longer teacher horizon benchmark

{"pairs": 100, "shortTeacherScore": 0.27, "longTeacherScore": 0.26, "teacherDelta": -0.01, "pairedBootstrap95ci": [-0.1, 0.08], "plainIdentical": true, "limitation": "Same seeds and policies but horizon changes rollout RNG consumption. Privileged synthetic teacher, not Elo."}

## Targeted support training pilot

137 legal support-stat variants from27 training-source rooms (5Decorate rooms,22Coaching rooms), with moves/items retained and zero held-out pack overlap. Search teacher support-challenge100 paired seeds score .390 vs plain .060, delta .330 CI[.240,.420];34 search battles attempted support moves. Training-source challenge only. New search-support-adapt-20260929 uses29.55% targeted team sampling, frozen parent warm start and new optimizer, new seed20261353, stages400/4000, independent held-out seed4112000000.400 checkpoint guarded score .9075 vsparent .8775, paired+.030 CI[.0075,.055]; other standard opponent deltas nearzero. No ladder promotion;4000 held-out and support challenge pending.

## Legal ally-target candidate fix

Found Decorate normal target and HealPulse any target lacked ally candidates in moveOptions; engine validTargetLoc permits adjacent ally for normal and non-self ally for any. Added legal living-ally candidates and ally type effectiveness in shared generator; compiled isolated ally-target runtime. Existing frozen training/ladder runtimes retained. Original support benchmark counts attempts, including opponent-targeted Decorate, and does not establish ally support coordination. New100-pair support-challenge-ally benchmark counts actor/target side separately. Early support400 guarded gain did not reproduce on fresh200 seeds (both .9025); no promotion.

## Support candidate and heuristic corrections

Stopped old support-training run, preserving checkpoints, because Decorate could not target allies. Completed ally-targetv1 diagnostic: {"pairs": 100, "plainTeacherScore": 0.43, "searchTeacherScore": 0.91, "teacherDelta": 0.48, "pairedBootstrap95ci": [0.38, 0.58], "allySupportAttempts": {"plain": 79, "search": 79}, "limitation": "Ally-target candidate fixv1. Later v2 heuristic/human setup corrections compiled separately and not evaluated here. Training-source diagnostic, not Elo."} Added negative heuristic score for ally damage (PollenPuff excepted) and opponent-targeted Decorate, plus human setup eligibility/ranking for ally Decorate; compiled ally-target-v2-20260930 isolated runtime. New corrected support training still pending.

## 12000-stage rated trial

General search adaptation completed. Initial200 paired seed heuristic+.0325 CI[.0025,.0625],human+.0375 CI[.0075,.0675]; fresh200 confirmsheuristic+.035 CI[.0075,.065],guarded+.0325 CI[0,.065],human+.005 CI[-.030,.040]. Search teacher200 pairs learner .775 vsparent .760, delta+.015 CI[-.055,.080], no demonstrated teacher gain. Queued exploratory60-game plain-policy trial with bulk team and original frozen joint-retry/runtime feature4. Unique ladder metadata SHA preserves configuration provenance. Current client preserved; starts next session. No Elo or goal success inferred from local results.

## Support-v3 correction and current execution

Unrestricted normal/any ally-damage candidates collapsed parent held-out scores (.1275heuristic/.165guarded/.125human);16 diagnostic battles selected51/195 positive-power ally-target move components. Stopped v2training and preserved artifacts. Shared generator now offers ally-target normal/any status moves and PollenPuff healing, omitting general friendly-damage combinations pending explicit curriculum. New frozen search-support-v3-20260930 control .885heuristic/.890guarded/.8875human,400 checkpoint .895/.890/.8625; no promotion. Training continues4000 and support-student-v3-4000 comparison waits for frozen checkpoint. V3support challenge100pairs plain .070/search .320, paired+.250 CI[.160,.340],45 search ally-support attempts. General12000 checkpoint registered for exploratory60game ladder trial following current session; metadata0e268760e968f5430425e1167ebda920be03bcd4b68c500e4ed70036e710beb0.

## Preview diagnostic and support-v3 stage completion

Preview oracle100 pairs retained ArcanineFloette leads98cases; scores+.02/plain CI[-.03,.07],+.04/search CI[-.04,.12]. No clear gain; no preview behavior change. Support-v3 completed4000, standard held-out deltas {"random": {"delta": -0.005, "pairedBootstrap95ci": [-0.02, 0.01]}, "heuristic": {"delta": 0.005, "pairedBootstrap95ci": [-0.0225, 0.035]}, "guarded": {"delta": -0.005, "pairedBootstrap95ci": [-0.035, 0.0225]}, "human": {"delta": 0.0075, "pairedBootstrap95ci": [-0.025, 0.04]}}; no demonstrated broad gain. Targeted challenge comparison retained separately.

## Search imitation, team and joint-head experiments

160 teacher trajectories128train/32validation source rooms,862public-state decisions/602search labels. Full imitation validation NLL3.269→2.671 but accuracy.723→.607; fresh200 held-out heuristic delta-.0325 CI[-.0575,-.010]. No promotion. Advantage>.05 fit71train/16validation labels, stronger KL2.0; heuristic-.0375 CI[-.065,-.010], no promotion. Public replay API returned403; no external expert replays acquired. RockHead variant200pairs no clear gain vsIntimidate; kept original ability. Matched joint-head/control warm adaptations launched from12000 parent with same training seed20261355 and corrected support pool; residual zero-output head adds4225parameters.400 paired-stage comparison all gain intervals includezero. Both continue4000; current rated12000 policy trial remains separate.

## Update 2026-09-30 (encoder audit): weather/terrain blindness found and fixed (view v3)

- `scripts/view-audit2.mjs` compares `VisibleState` with simulator truth per turn. v2: weather wrong 107/454 (parsed `[from]`/`[upkeep]` text instead of the weather name), terrain wrong 67/454 (never recognised), Light Screen stored as `movelightscreen`, foe boosts wrong 67/770 (not reset on switch). Cause: Showdown puts the name in the first argument for `-weather`/`-fieldstart`/`-fieldend`; the parser read the second.
- Fix: `CHAMPIONS_VIEW=3` (`receiveField`, boost reset on switch). Audit after: terrain/room/side conditions 0 mismatches, weather 2/454 (naming only), own boosts 0/714.
- Consequence: every policy so far never saw weather, terrain, Trick Room, Gravity or Tailwind/Reflect/Light-Screen status of Showdown-formatted messages. Species that set these (Tyranitar 80%, Politoed 67%, Excadrill 70%, Indeedee 70%, Charizard 70% opponent win rate vs us) are among our worst matchups. This is the strongest explanation found so far for local strength not transferring.
- `humanclimb7-20260929` (CHAMPIONS_VIEW=3): two GRUs warm-started from h5v2-team1a plus one from scratch, mix human 0.5 / heuristic 0.05 / selfplay 0.25 / pool 0.2, stages 20k-100k. Evaluate with `CHAMPIONS_VIEW=3`. Ladder queue takes a per-entry `"view"` key.
