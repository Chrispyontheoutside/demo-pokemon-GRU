# Showdown Arena: play the Gen 6 learner

A trained local opponent is included at `models/gen6-policy.json`. Start the app with `npm start`, then open **http://127.0.0.1:3000/play.html** and choose **Start battle**. No Python process is needed to play. The original Gen 9 agent arena remains at `/`.

You get six random Pokémon. Choose a move or select a teammate to switch; when available, check **Mega Evolve with this move** before choosing the move. Forced replacements, fainted Pokémon, trapped states, and unavailable moves are handled by the simulator requests. The learner responds immediately. You can reload the page to resume, forfeit, download the spectator replay, and play again. There is no turn timer while the page is open; abandoned sessions expire after 30 minutes. Battles are memory-only and do not survive server restarts. A safety cap ends games at 400 turns.

The app server binds to `127.0.0.1` only. Its battles and all learning run in the installed Showdown simulator. The browser is a human play interface, not a training environment. Renderer code/data are local; Pokémon sprites, backgrounds, and audio load over HTTPS from the official Showdown asset host. The separate, explicitly invoked online trial below connects to public matchmaking.

## What was trained

- Structured policy/value network, **29,473 parameters**, CPU, PyTorch 2.14.0. No LLM.
- 426 state features → 64-unit tanh trunk → 32 action-feature coefficients and a value head. Shared action scoring with a 14-slot legal mask: four moves, four Mega variants, six switches.
- 8,195 heuristic imitation decisions, then **200,000 PPO decisions**, totaling **8,380 training battles**. Only PPO decisions count toward the checkpoint's `steps` field.
- Terminal +1/−1/0 rewards, GAE, clipped PPO, entropy bonus; frozen rollouts against an 80% damage-heuristic / 20% random opponent mixture. No self-play yet.
- One persistent Node simulator worker. A complete training invocation took **107.7 seconds** inside the timed loop on this M5/16 GB laptop, including its initial evaluation. About 1,930 PPO decisions/second over warmup plus training; this short run does not establish sustained overnight throughput. MPS was unavailable in the training process; GPU was not needed.
- Python and Node inference agree numerically; saved rollout log probabilities are verified before updates. PPO alone changed weights by L2 norm **8.13**, and all recorded losses were finite.

`models/gen6-policy.training.json` retains training metrics. `models/gen6-policy.pt` retains optimizer/model/RNG state locally and is ignored by Git. The JSON model is the deployable local-play artifact (about 598 KiB). Checkpoints are written atomically, and each battle keeps the model it started with.

## Measured strength

Frozen evaluation used seed indices 2,000,000–2,000,499, disjoint from training. For each seeded team pair, the learner played each team once in opposite seats: **1,000 games per opponent**. Confidence intervals resample whole pairs.

| Opponent | Wins / games | Win rate | Paired 95% bootstrap interval |
|---|---:|---:|---:|
| Uniform legal-action random | 985 / 1,000 | 98.5% | 97.7%–99.2% |
| Damage/type/accuracy heuristic | 449 / 1,000 | 44.9% | 42.2%–47.7% |

No draws or turn-cap truncations occurred. The heuristic-only imitation checkpoint scored 98.1% against random and 45.9% against the heuristic on the same seeds. **This PPO run does not establish an improvement over imitation.** It is a working trainable beginner opponent, not a strong competitive agent. No public-ladder rating is claimed. The initial in-run evaluation repeated the learner's team rather than giving it both teams; those results were superseded, and the evaluator was corrected before producing the table above. Full final results are in `models/gen6-policy.evaluation.json`.

## Run, train, evaluate

Node 24+ is required. Dependencies and viewer assets are already present in this workspace. On a fresh checkout:

```sh
npm ci
npm run setup:viewer
npm start
```

To install the optional training environment on a supported Apple Silicon Python:

```sh
python3 -m venv .venv-rl
.venv-rl/bin/python -m pip install -r agents/requirements-rl.txt
```

The pinned Python environment was tested with Python 3.14.7. To reproduce the delivered model, use a separate output path so you preserve it:

```sh
npm run train:gen6 -- --steps 200000 --warmup 8192 --seed 1234 --eval-pairs 100 --output models/experiment.json
```

To continue from the saved local training state, preserving the delivered checkpoint:

```sh
npm run train:gen6 -- --resume models/gen6-policy.pt --steps 100000 --eval-pairs 100 --output models/continued.json
```

To evaluate a frozen JSON model on complementary team/seat pairs:

```sh
npm run build
.venv-rl/bin/python agents/evaluate_gen6.py models/gen6-policy.json --pairs 500 --seed 2000000 --output models/recheck.evaluation.json
```

Use new held-out seeds when choosing among many experiments. The play server loads `models/gen6-policy.json`; back it up before promoting a new model. `--steps` requests additional PPO decisions and can overshoot to finish an episode. Interrupted training preserves the last completed update. Training games that hit the cap are discarded and counted; no such discards occurred in the delivered run. This prototype uses full episodes rather than a general time-limit-bootstrapped environment.

## 20-million-game local self-play run

The requested run is in `runs/gen6-selfplay-20m-20260927/`. It starts from the delivered learner and targets **20,000,000 additional completed self-play battles**, with both players controlled by the same policy frozen for each rollout batch. Both players' trajectories train the shared PPO model; a battle counts once, not once per player. Truncated attempts are discarded and do not advance the target. There are no public-server connections in this run.

The original `models/gen6-policy.json` and `.pt` remain unchanged. The local play UI continues using that original model until a separately evaluated replacement is selected. The new checkpoint is `runs/gen6-selfplay-20m-20260927/model.json`; its matching `.pt` stores optimizer state, RNG and counters for resume. These generated run files are ignored by Git.

`model.status.json` reports progress, process IDs, last saved game count and an estimated remaining time. `training.log` retains per-update metrics and evaluation summaries. Checkpoints are replaced atomically about every 60 seconds and on graceful shutdown; RAM retains only the latest 200 metrics, with no full-game archive. At the pilot's ~60 completed games/second, 20 million games projects to ~92 hours; expect several days and variation as games get longer or the laptop is busy. The pilot used under a minute for 2,000 games; it is not proof of sustained multi-day throughput.

The background process uses two PyTorch CPU threads at reduced scheduling priority, plus one Node simulator process. An idle-sleep inhibitor runs with the trainer. Keep the laptop powered; lid closure, forced sleep or shutdown can interrupt progress. This is a background process, not an installed startup service. After interruption, use the same cumulative target:

```sh
caffeinate -i .venv-rl/bin/python -u agents/train_gen6.py \
  --resume runs/gen6-selfplay-20m-20260927/model.pt \
  --self-play-games 20000000 --eval-pairs 100 --eval-every-games 100000 \
  --quality-reference models/gen6-policy.json --quality-pairs 500 \
  --output runs/gen6-selfplay-20m-20260927/model.json \
  >> runs/gen6-selfplay-20m-20260927/training.log 2>&1
```

To stop safely, send `SIGTERM` to the trainer `pid` in `model.status.json` (verify that it still identifies this trainer). It finishes the current update and saves; a forced kill may lose progress since the previous checkpoint. An output lock prevents simultaneous writers.

Evaluation runs at startup, about every 100,000 completed games, and at completion against random and heuristic opponents: 100 complementary pairs each, using seed indices starting at 3,000,000,000, separate from the planned training range. The latest results are in `model.evaluation.json`; historical summaries remain in the log. Self-play's average reward is zero by construction, so use these external opponents to assess progress. Current-policy self-play can cycle or forget skills; the requested volume does not guarantee improvement. Use a fresh larger held-out evaluation before promoting the result.

### Protection against regressions

The live run was saved and resumed at **47,974 self-play games** with a separate quality gate enabled. At startup, each periodic evaluation, and completion, it checks 500 complementary team pairs (1,000 battles per matchup) on fresh seed blocks starting at 3,200,000,000. The candidate faces the retained best checkpoint directly, and the original checkpoint too once those differ. Each candidate/reference also faces the fixed random and heuristic opponents on identical seeds.

A candidate replaces `quality/best.json` and `quality/best.pt` only if its head-to-head score has a 99% paired-bootstrap lower bound above 50% against every reference, and its baseline-score change has a lower bound no worse than **−3 percentage points** against both references. The margin is a practical tolerance, not a claim of zero degradation. Inconclusive and failing results retain the previous best. Accepted checkpoints are also archived as `quality/accepted-<games>.json`/`.pt`; the original is retained separately. These files are selection artifacts, not automatic replacements for the app's playable model.

`quality/selection.json` contains the latest decision, intervals, clear-regression flags and consecutive-regression count. The full sequence is in `training.log`. The requested 20-million-game training budget continues even when a checkpoint fails selection; no automatic reset or early stop is configured. A persistent regression calls for reviewing the training setup rather than assuming that more games will fix it. Checks add runtime overhead to the original pilot estimate.

These are finite-sample screening checks, not a universal guarantee: repeated comparisons can select lucky checkpoints, opponent coverage is limited, and performance can change against other policies. Keep a separate unused final test set before choosing a playable release. A pool of historical training opponents, broader baselines, multiple training seeds and a richer observable-state encoder remain useful follow-up work. The current training distribution is still both-seat current-policy self-play.

The first independent snapshot comparison (37,044 self-play games, 2,000 games per opponent/model) scored 53.85% against the heuristic versus the original's 48.70% on the same fresh pairs. Its paired 99% interval for the difference was +1.75 to +8.70 percentage points. Random-opponent scores were 99.20% versus 98.95%, with no clear difference. This is encouraging evidence on those tests, not a projection of the final result. Full data is in the run's `quality/first-comparison.json`.

Verification: `npm test` covers both-player rollout rewards, legal on-policy actions, frozen-model matches and exact counting. `.venv-rl/bin/python scripts/check-selfplay.py` exercises graceful shutdown, duplicate-writer rejection, an exact resumed target, changed weights and preservation of the original checkpoint. `.venv-rl/bin/python scripts/check-quality.py` checks acceptance, inconclusive results, regressions and mismatched evaluation seeds.

## Optional public-ladder trial

The [September 14 trial](reports/online-2026-09-14/README.md) recorded two wins (opponent forfeit and disconnection), but also an unresolved long response delay. Diagnose that delay locally before further public testing; these results do not establish playing strength.

Only run this when public play is intended and authorized:

```sh
npm run build
node dist/src/online-gen6.js 2
```

This connects directly to the official Showdown server as a temporary `G6LearnerBot` name and plays 1–3 sequential Gen 6 Random Battles (default 2). It uses the saved model and the same observation encoder, without training or changing the checkpoint. Node's built-in WebSocket/fetch APIs require no additional dependency or browser. Authentication assertions are never saved. No chat messages are sent. Public battle logs, choices, model hash and results go into a timestamped `.cache/online-*` directory. Opponents are ladder users; the client cannot verify that they are human.

Search expires after three minutes; interrupted or failed active sessions forfeit and disconnect. An unexpected rejected action stops the trial instead of continuing with a fallback strategy. This is a supervised trial adapter, not an unattended ladder bot. Server mechanics and random sets may differ from the locally pinned simulator. Follow [Showdown's rules](https://pokemonshowdown.com/rules) and respect server restrictions.

## Verification and boundaries

```sh
npm test
npm run typecheck
node scripts/check-play.mjs
```

The last command needs the local server running and creates its own disposable test battle. It verifies a natural game result, replay output, and rejection of stale, illegal, post-game, and cross-origin action requests. Unit/integration checks cover request masks, Mega variants, Struggle and Recharge, visible-state updates, unknown opponent slots, deterministic games, caps including pending human input, checkpoint compatibility, natural human-controlled games, cancellation, and the existing arena store.

Browser checks covered starting a game, an ordinary switch, a move, forced replacement, Mega Evolution with Protect, consumption of Mega availability, reload recovery, forfeit, and the finished state. The renderer displays Mega sprites correctly, logs each event once, and remains within a 390px viewport. Native buttons/checkboxes retain keyboard focus indicators; reduced-motion styling is supported.

Player observations originate only from each player's redacted simulator stream and private request. Neither policy nor value reads opposing generated teams, opponent exact HP, battle RNG seeds, or the other player's pending choice. The evaluator owns those seeds separately. The compact encoder is deliberately incomplete: it omits most item/ability identities, detailed move histories, many temporary effects, and hazard layer counts. Illusion and uncommon transformations need a more complete identity/state tracker for serious competitive training. Damage features are approximations, not a damage calculator. Simulator mechanics remain authoritative even when the policy's features are incomplete.

The original arena's recovery-schema and completed-result rating bugs are repaired. Existing source files and user assets were preserved through focused edits, not a reset or replacement. The workspace started without any Git commits; changes remain uncommitted. The initial design and simulator benchmarks are preserved in `GEN6_RL_ASSESSMENT.md`.

The next useful work is a richer public-state encoder, stronger baseline/opponent diversity, and multiple training seeds with held-out evaluation. Longer training alone is not justified by the present comparison. The current goal—an actual trained learner you can play against locally—is implemented.
