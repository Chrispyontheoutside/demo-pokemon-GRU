# Reg M-B to Reg M-C preflight

Simulator source: Showdown commit `a5df8274e85b0889bf2a9b3422a08b39732374fc` (package version `0.11.11`). The frozen M-B snapshot is under `archives/m-b-2026-09-28/` and is not used to initialize M-C weights.

## Format rules

Both VGC formats use Doubles, `Flat Rules`, `VGC Timer`, and `Open Team Sheets`. The archived M-B format used the Champions mod. Current Showdown keeps M-B as a legacy `championsregmb` format and hides it from ladder search; M-C uses the current `champions` mod and is rated. An authenticated live search for `gen9championsvgc2026regmc` was accepted by `sim3` and canceled before matchmaking.

## Roster and items

Using the current format Dex, M-C has 392 legal species/forms versus 357 in the current legacy M-B mod. M-C adds 35 legal species/forms:

Wigglytuff, Persian, Persian-Alola, Farfetch’d, Mr. Mime, Swalot, Absol-Mega-Z, Salamence, Salamence-Mega, Garchomp-Mega-Z, Lucario-Mega-Z, Gogoat, Golisopod, Golisopod-Mega, Rillaboom, Cinderace, Inteleon, Thievul, Toxtricity, Toxtricity-Low-Key, Grapploct, Perrserker, Sirfetch’d, Pincurchin, Indeedee, Indeedee-F, Pawmot, Arboliva, Squawkabilly, Squawkabilly-Blue, Squawkabilly-Yellow, Squawkabilly-White, Mabosstiff, Baxcalibur, and Baxcalibur-Mega.

M-C has 18 additional legal items: Absolite Z, Baxcalibrite, Eject Button, Garchompite Z, Golisopite, Leek, Lucarionite Z, Salamencite, Air Balloon, Binding Band, Electric Seed, Grassy Seed, Misty Seed, Normal Gem, Psychic Seed, Red Card, Rocky Helmet, and Terrain Extender.

## Mechanics data

Compared with the archived M-B Champions data, the current M-C simulator has 31 changed move records and 6 changed ability records. M-C restores moves including Court Change, Drum Beating, Glaive Rush, Jaw Lock, Overdrive, Pyro Ball, Revival Blessing, Shift Gear, and Zing Zap. Other concrete move-data changes include Slash at 80 base power, Meteor Assault at 170 base power, and 5 PP for Strength Sap and Wish. The M-C runtime also uses the current Champions battle scripts; its VGC rules and player-facing Mega Evolution action requests remain supported.

## Generator and interface

The team generator validates against M-C and supplements the simulator’s curated random doubles teams with a legal M-C-only species or its new Mega item in 25% of generated teams. The supplement uses only M-C learnsets. Revision `m-c-statpoints-v1` also assigns role-based natures and Champions’ 66 raw Stat Points (32 maximum in one stat), rather than spreading 11 points uniformly across every stat. The revised generator passed TeamValidator on 200/200 teams; 49 included an M-C-only species/form and 5 used an M-C-only Mega item.

The M-C observation/action path completed 200 random-policy battles before the stat-point revision and another 100 afterward. All 300 completed, with no unavailable-choice retries, truncations, or aborts in the latest 100. The interface remains 800 observation values and 56 action features; team preview and Mega choices were exercised.
