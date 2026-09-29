#!/bin/bash
# Launches the additional architecture/team experiments (transformer + warm-started GRUs) as one staged league campaign.
cd "$(dirname "$0")/.."
R=runs/champions-vgc-2026-reg-mc/registry/frozen
T=runs/champions-vgc-2026-reg-mc/teams
S=runs/champions-vgc-2026-reg-mc/fleet-20260928
mkdir -p "$S"
OPP=$(for i in 1 2 3 4 5 6 7 8; do printf "%s," "$T/pool2-$i.json"; done | sed 's/,$//')
MIX="heuristic=0.3,selfplay=0.3,pool=0.4"
CH=$R/da512c72a479/policy.json
cat > "$S/experiments.txt" <<E
f05-gru64-salazzle:gru:20260991:$CH:$MIX:$T/pool2-1.json:
f06-gru64-tauros:gru:20260992:$CH:$MIX:$T/pool2-2.json:
f07-tfgru-team1:gru:20260998:none:$MIX:$T/candidate-1.json:--trunk transformer
f08-tfff-team1:feedforward:20260999:none:$MIX:$T/candidate-1.json:--trunk transformer
f09-tfgru-salazzle:gru:20261000:none:$MIX:$T/pool2-1.json:--trunk transformer
E
POOL=$(cat runs/champions-vgc-2026-reg-mc/league-20260928/pool.txt) OPP_TEAMS=$OPP nohup scripts/run-champions-league.sh "$S" "30000 60000" 1 > "$S/driver.out" 2>&1 &
echo launched
