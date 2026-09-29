---
name: pokemon-showdown
description: Play or coach live Pokémon Showdown battles—especially Gen 6 Random Battles—with concise turn-by-turn strategy narration, matchup planning, hazard/status tracking, and careful move submission. Do not use for standalone Pokémon facts, team-building advice, or replay analysis unless live play is also requested.
---

# Pokémon Showdown Battler

Use this skill when the user asks to play a live Pokémon Showdown battle, wants narrated decisions while playing, or asks for live battle coaching through the browser.

## Live battle workflow

1. Open or reuse the Pokémon Showdown browser tab with Computer Use. Preserve the user’s requested format; if they name Gen 6 Randoms, select `[Gen 6] Random Battle` rather than the current default format.
2. Use a temporary username only when needed. Never transmit personal information or create an account unless the user separately requests and authorizes it.
3. Before each submitted action, send a compact narration update containing:
   - the current matchup and relevant HP/status;
   - the strongest candidate lines considered;
   - the chosen move or switch and its main risk/tradeoff.
4. Submit exactly one move or switch, then wait for the turn to resolve. After the result is visible, update the battle state before choosing again.
5. Continue until the battle is won, lost, forfeited, or the user stops the task. Leave the final result visible when that is useful.

## State to track

Maintain a compact internal ledger after every turn:

- both active species, known types, HP, status, boosts, and field effects;
- revealed moves, items, abilities, and meaningful damage clues;
- all revealed team members, fainted members, and plausible remaining checks;
- hazards on each side, especially Spikes, Stealth Rock, Toxic Spikes, and Sticky Web;
- speed evidence, priority, weather, terrain, Trick Room, and setup threats;
- the likely endgame plan: which Pokémon must be preserved and which can be traded.

Treat unconfirmed moves, items, abilities, and damage ranges as uncertain. Infer them only from visible battle evidence, and revise the inference when new evidence appears.

## Decision priorities

Prefer the line that best balances immediate value and endgame position:

1. Take a guaranteed or high-confidence KO when the opponent is in range.
2. Prevent an immediate sweep from setup, speed control, or a dangerous status move.
3. Preserve the specific answer needed for the opponent’s unrevealed threats.
4. Use type advantages and reliable coverage, checking immunities before submitting.
5. Manage hazards and status proactively; account for entry damage, Poison Heal, Leftovers, Life Orb recoil, weather, and recovery.
6. Use switches and pivots to gain information when the active matchup is poor, but do not switch reflexively when a safe KO or valuable progress is available.
7. Avoid speculative setup if the opponent can immediately inflict a KO, phaze, disable the setup, or gain a decisive position.

In Random Battles, a move that is super-effective is not automatically best: compare accuracy, damage, immunities, likely switches, recoil, status, and what the move reveals. When using a phazing move, account for the opponent’s remaining team and hazards before choosing it.

## Damage and risk management

Use an available damage calculator when it is accessible and appropriate, especially for uncertain KO ranges, boosted attackers, priority races, and bulky targets. If no calculator is available, use Showdown’s move-effectiveness tooltip, known move power, STAB, observed damage, and conservative qualitative ranges. Do not present an estimate as an exact calculation.

For each consequential choice, explicitly assess:

- best case, worst case, and the most likely opponent response;
- whether the chosen Pokémon remains useful if the line fails;
- whether a safer line makes comparable progress;
- whether the line preserves a win condition for the final three Pokémon.

## Computer Use discipline

Use the live UI rather than guessing from stale state. After every click or selection, refresh the accessibility state before relying on element indices. Verify that the page visibly shows the selected move or switch before waiting for resolution. If an element becomes detached or the UI changes, re-observe and retarget it; never repeat a stale index blindly.

When the battle ends, verify the visible result—win, loss, forfeit, or timeout—before reporting it. Do not claim a win merely because an attack was submitted.

## Narration style

Keep updates short enough to follow during a live timer. Use this shape:

`Turn N — Observation: ... Choice: ... Risk: ...`

After resolution, mention the important consequence in one sentence, then proceed to the next turn. Be candid about uncertainty, mistakes, missed ranges, and UI selection errors. Do not imply that a calculator or hidden information was used when it was not.
