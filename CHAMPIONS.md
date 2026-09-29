# Champions VGC Reg M-C agent (`gen9championsvgc2026regmc`)

A local reinforcement-learning agent for Pokémon Champions VGC (Reg M-C) that plays the real Showdown ladder. Everything trains locally
against the bundled simulator; only our own battles are used as data (no external replays, human demonstrations or pretrained models).

**Goal (current):** 1350 real rated ladder Elo, sustained. Real ladder Elo is the only authoritative metric; local win rates are proxies.
A milestone needs at least 50 rated games, a final rating at or above the threshold, and a last-25-game mean at or above it.

## Honest state (2026-09-29)

- Best real result: about 1229 final / 1273 peak on the new account `avin-owes-me-25` (52-59 over 111 games, genuine 44-59 after removing
  8 early forfeits); the old account peaked at 1218. These are spikes around a ~1100 population, not a sustained rating. No milestone is frozen.
- Local strength (0.85-0.90 vs the scripted heuristic) has never transferred to the ladder. Diagnosed gap: our agent switches voluntarily
  0.03 times/game vs 0.48 for humans and Protects 4.5% vs 11.8%.
- Found and fixed a roster-tracking bug in `VisibleState` (see below): the opposing fainted/benched count was wrong in ~64% of states.
- Deployable ladder-side search (reconstruct the battle from our own information, roll out candidates against a human-behaviour model) gives
  +8 points (95% CI +0.7 to +15.3) over the same policy without search against the human-rate opponent on held-out human teams, ~1.3 s/decision.
  It has not yet been played on the ladder.
- The detailed, dated journal is `runs/champions-vgc-2026-reg-mc/STATUS.md` (copy in `docs/champions-status.md`).

## Setup

```
npm install
python3 -m venv .venv-rl && .venv-rl/bin/pip install torch numpy      # trainer only
npm run build
npm test                                                             # 26+ tests, including Python<->Node inference parity
```

## Train

```
npm run train:champions -- --architecture gru --training-opponent mix \
  --opponent-mix human=0.55,heuristic=0.05,selfplay=0.2,pool=0.2 --pool a.json,b.json \
  --learner-teams runs/.../teams/candidate-1.json --opponent-teams "$(ls runs/.../teams/human-[0-9]*.json | paste -sd, -)" \
  --battles 60000 --workers 2 --output runs/my-run/policy.json
```

- Architectures: `gru` (default), `feedforward`, wide/deep (`--hidden`, `--depth`), entity transformer (`--trunk transformer`, ~4 battles/s).
- Opponent kinds: `heuristic`, `heuristic2` (guarded scripted), `human` (empirical human rates, below), `random`, `selfplay`, `pool` (frozen checkpoints).
- `scripts/run-champions-league.sh <dir> "<stages>" <workers>` runs several experiments per `experiments.txt` line
  `name:arch:seed:init-checkpoint:opponent-mix:learner-team:extra-args`, snapshotting and evaluating per stage.
- Throughput: ~90-105 battles/s per experiment, ~160 battles/s aggregate on a 10-core M5. Training is bit-exact reproducible across worker counts.
- Set `CHAMPIONS_VIEW=2` for the corrected roster tracking (all new experiments should); the default (v1) matches existing checkpoints.

## Human-behaviour opponent (what "human local players" means)

`scripts/human-behaviour.py` parses our own ladder logs (both accounts, ~500 battles) and writes
`runs/champions-vgc-2026-reg-mc/human-behaviour.json`: per turn bucket x HP bucket rates of Protect / Fake Out / voluntary switch / attack, plus
per rating band (low <1061, mid, high >=1145) tables and focus-fire rates. `humanAction` in `src/champions-worker.ts` samples those rates per
slot and lets the damage heuristic choose within the sampled kind. Finding: humans switch ~4-10% per slot-turn almost independently of HP.
Rating-band styles are computed but not yet sampled per battle by `humanAction` (next step for variety).

`scripts/build-human-teams.mjs` builds legal teams mirroring opposing teams we saw (`teams/human-*.json`, 60 held out).

## Evaluate

```
EVAL_HUMAN=1 EVAL_GUARDED=1 EVAL_JOBS=4 node scripts/evaluate-champions-vgc.mjs policy.json 300 <seed>     # vs heuristic, guarded, human, random
scripts/eval-candidate.sh <label> policy.json team.json opp-team1.json,opp-team2.json [frozen.json] [pairs]  # one-line summary
```

Paired-seed evaluation; 120-game comparisons carry about +-0.09 noise.

## Ladder-side search (deployable)

`src/reconstruct.ts` rebuilds a searchable battle from our request and `VisibleState` (own team exact, opposing sets sampled from per-species
frequencies over our logs); `src/ladder-search.ts` rolls out candidates over several determinizations and samples from softmax(Q/tau) x policy prior.
`scripts/reconstruct-check.mjs` round-trips a simulated game; `scripts/ladder-search-eval.mjs` measures search vs plain with only the acting
side's information:

```
CHAMPIONS_VIEW=2 node scripts/ladder-search-eval.mjs --policy p.json --team t.json --opp-teams a.json,b.json --opp human --games 150 --jobs 3
```

Enable on the ladder with `LADDER_SEARCH=1` (skipped on forced replacements and when reconstruction is not possible; notes go to `<room>.search.json`).

## Ladder

```
npm run ladder:champions -- <games 1-3> <policy.json> <team.json>       # one bounded session; carries GRU memory between turns
node scripts/champions-registry.mjs ingest-ladder runs/champions-vgc-2026-reg-mc/ladder/*/summary.json   # per-checkpoint records
python3 scripts/watch-milestone.py 1250                                 # captures evidence when a rated win reaches the threshold
```

The registry freezes hash-keyed checkpoints and classifies endings (normal / early forfeit / substantial forfeit / timer); the genuine record
excludes early-forfeit and timer wins. Account name lives in `.cache/champions-vgc-2026-reg-mc-ladder-user.json` (gitignored). Open Team Sheets are not accepted.

## Findings worth keeping

- `VisibleState` v1 looked in the departing slot first, so every switch or replacement renamed the departing roster entry; the opposing roster lost
  fainted and benched members (`scripts/view-audit.mjs`: fainted count wrong in 180/281 states; v2 wrong in 0). The old control policy scores the
  same under both views locally (0.867 vs 0.857 vs heuristic), so the fix is expected to matter for newly trained policies.
- Local opponents are too weak relative to the ladder; own-battle data (~500 games) is too small to imitate humans well; scale, capacity, league,
  evolved teams, shaping, switch exploration and expert iteration did not move ladder Elo.

## Layout

`agents/` trainer + fine-tune; `src/` simulator, encoder, workers, search, ladder client; `scripts/` evaluation, registry, human-behaviour,
reconstruction and search tools; `reports/` evaluation reports; `runs/` (gitignored) checkpoints, ladder logs, teams, registry.
