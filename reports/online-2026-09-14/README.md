# Public Gen 6 Random Battles trial — September 14, 2026

The saved 200,000-step learner played two sequential rated games on the official Pokémon Showdown server as **G6LearnerBot8926**. The server recorded two wins. All decisions came from the saved structured policy, with its existing stochastic sampling; no assistant move selection or online training was used. The checkpoint hash was unchanged afterward. The trial disconnected after the second game.

| Opponent | Displayed starting rating | Result | Turn | Termination |
|---|---:|---|---:|---|
| bmp83h | 1160 | Win | 17 | Opponent forfeited |
| ackerjigen | 1040 | Win | 8 | Opponent disconnected and lost by inactivity |

These are public-ladder opponents, not verified human identities. Neither result was a complete knockout victory. Two games, one ending by disconnection, do not establish competitive strength or a reliable rating. The bot started at 1000 and the next game's player record showed 1057; no final rating was captured.

## Timing issue and next step

The second game's log shows approximately **142 seconds** between Crawdaunt fainting and the learner selecting Salamence. The opponent disconnected during that interval. The first game also contains a shorter timer warning for the learner. No rejected action was recorded, but this is not acceptable behavior for further public testing.

The initial adapter did not record request-arrival or action-dispatch timestamps, so these logs cannot distinguish delayed server requests, network delivery, a suspended laptop/process, or client dispatch. Forced replacement is handled immediately in the local adapter regression check; that does not resolve the observed online delay. Per-decision inference duration and frame/dispatch timestamps were added after the trial. Investigate under an uninterrupted foreground process against a local server before another public trial. Do not interpret this inactivity win as evidence of policy quality.

## Evidence and verification

- `summary.json`: results, opponent names/starting ratings recovered from battle logs, model hash and limitations.
- The two `.log` files: received battle events (private own HP is visible); spectator chat and authentication assertions are excluded.
- The two `.decisions.json` files: selected actions and request IDs; these original trial files predate the added timing diagnostics.
- Live room links, which may expire: [first game](https://play.pokemonshowdown.com/battle-gen6randombattle-2681305933), [second game](https://play.pokemonshowdown.com/battle-gen6randombattle-2681307339). Replays were not uploaded.

All 15 tests pass, including the online adapter's full-frame updates, duplicate/wait requests, forced replacement, terminal state, and preservation of an opponent's name after disconnect. The disconnect-name fix and timing instrumentation were applied after the two games. Existing local play/training entry points remain separate from the explicitly invoked public adapter.
