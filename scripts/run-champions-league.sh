#!/bin/bash
# Staged concurrent league training: mixed opponents (heuristic / self-play / frozen historical pool), snapshot + evaluate per stage.
# experiments.txt lines: name:arch:seed:init-checkpoint:opponent-mix[:learner-team-files]   (env POOL = comma list of frozen checkpoints;
# env OPP_TEAMS = comma list of team files used for about half of opponents when learner teams are set)
set -u
cd "$(dirname "$0")/.."
CAMPAIGN=${1:?dir}; STAGES=${2:?stages}; WORKERS=${3:-2}; POOL=${POOL:?POOL required}
EXP_FILE=${EXP_FILE:-$CAMPAIGN/experiments.txt}; LOG=${LOG_FILE:-$CAMPAIGN/campaign.log}; mkdir -p "$CAMPAIGN"
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG"; }
for stage in $STAGES; do
  log "stage $stage: training"; pids=()
  while IFS=: read -r name arch seed init mix lteams extra; do
    [ -z "$name" ] && continue
    dir="$CAMPAIGN/$name"; mkdir -p "$dir"
    if [ -f "$dir/policy.pt" ]; then resume="--resume"; elif [ "$init" != "none" ]; then resume="--init-from $init"; else resume=""; fi
    .venv-rl/bin/python agents/train_champions.py --architecture "$arch" --training-opponent mix --opponent-mix "$mix" --pool "$POOL" ${lteams:+--learner-teams "$lteams" --opponent-teams "${OPP_TEAMS:?OPP_TEAMS required}" --opponent-team-share "${OPP_SHARE:-0.5}"} \
      --battles "$stage" --seed "$seed" --workers "$WORKERS" $resume $extra --output "$dir/policy.json" >> "$dir/train-stage.log" 2>&1 < /dev/null &
    pids+=($!)
  done < "$EXP_FILE"
  for pid in "${pids[@]}"; do wait "$pid" || log "WARNING: trainer pid $pid exited nonzero"; done
  log "stage $stage: snapshot and evaluate"
  while IFS=: read -r name arch seed init mix lteams extra; do
    [ -z "$name" ] && continue
    dir="$CAMPAIGN/$name"; cp "$dir/policy.json" "$dir/policy-$stage.json"; cp "$dir/policy.pt" "$dir/policy-$stage.pt"
    report=$(EVAL_JOBS=5 node scripts/evaluate-champions-vgc.mjs "$dir/policy-$stage.json" 400 3130000000 2>/dev/null < /dev/null | grep -m1 '"reportPath"' | sed 's/.*"reportPath": "\(.*\)".*/\1/')
    log "RESULT stage=$stage name=$name arch=$arch seed=$seed checkpoint=$dir/policy-$stage.json report=$report"
  done < "$EXP_FILE"
done
log "campaign complete"
