#!/bin/bash
# Staged, concurrent M-C training campaign: several independent experiments train in parallel (each with its own
# ledger/status), pause at each stage boundary, are snapshotted, and are evaluated on the fixed suite.
#
# Usage: scripts/run-champions-campaign.sh <campaign-dir> "<stage battles, e.g. 50000 100000>" <workers-per-experiment>
# Experiments: "<name>:<architecture>:<seed>:<existing-run-dir or ->" lines are read from <campaign-dir>/experiments.txt.
set -u
cd "$(dirname "$0")/.."
CAMPAIGN=${1:?campaign dir}
STAGES=${2:?stage list}
WORKERS=${3:-2}
EVAL_SEED=3130000000
EVAL_PAIRS=400
LOG="$CAMPAIGN/campaign.log"
mkdir -p "$CAMPAIGN"

log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG"; }

run_dir() {  # name existing -> directory holding policy.json
  if [ "$2" = "-" ]; then echo "$CAMPAIGN/$1"; else echo "$2"; fi
}

for stage in $STAGES; do
  log "stage $stage: training"
  pids=()
  while IFS=: read -r name arch seed existing; do
    [ -z "$name" ] && continue
    dir=$(run_dir "$name" "$existing")
    mkdir -p "$dir"
    resume=""
    [ -f "$dir/policy.pt" ] && resume="--resume"
    .venv-rl/bin/python agents/train_champions.py --architecture "$arch" --training-opponent heuristic \
      --battles "$stage" --seed "$seed" --workers "$WORKERS" --torch-threads 1 $resume \
      --output "$dir/policy.json" >> "$dir/train-stage.log" 2>&1 < /dev/null &
    pids+=($!)
  done < "$CAMPAIGN/experiments.txt"
  for pid in "${pids[@]}"; do wait "$pid" || log "WARNING: trainer pid $pid exited nonzero"; done

  log "stage $stage: snapshot and evaluate"
  while IFS=: read -r name arch seed existing; do
    [ -z "$name" ] && continue
    dir=$(run_dir "$name" "$existing")
    cp "$dir/policy.json" "$dir/policy-$stage.json"
    cp "$dir/policy.pt" "$dir/policy-$stage.pt"
    report=$(EVAL_JOBS=5 node scripts/evaluate-champions-vgc.mjs "$dir/policy-$stage.json" "$EVAL_PAIRS" "$EVAL_SEED" 2>/dev/null < /dev/null \
      | grep -m1 '"reportPath"' | sed 's/.*"reportPath": "\(.*\)".*/\1/')
    log "RESULT stage=$stage name=$name arch=$arch seed=$seed checkpoint=$dir/policy-$stage.json report=$report"
  done < "$CAMPAIGN/experiments.txt"
done
log "campaign complete"
