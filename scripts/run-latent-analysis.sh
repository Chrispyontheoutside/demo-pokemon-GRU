#!/bin/bash
# One latent-reasoning analysis pass over the live campaign checkpoints (+ untrained references), then a delta vs the previous pass.
cd "$(dirname "$0")/.."
O=runs/champions-vgc-2026-reg-mc/official-66-point
C=runs/champions-vgc-2026-reg-mc/campaign-20260928
node scripts/analyze-battles.mjs --pairs "${PAIRS:-60}" \
  --reference ff-init=$O/seed-20260935-corrected-simple-5000-rerun/initial-policy.json,gru-init=$O/seed-20260936-gru-heuristic-5000/initial-policy.json \
  --checkpoints ff37=$O/seed-20260937-feedforward-heuristic-5000/policy.json,gru37=$O/seed-20260937-gru-heuristic-5000/policy.json,ff38=$C/ff-20260938/policy.json,gru38=$C/gru-20260938/policy.json 2>/dev/null
node -e '
const rows=require("fs").readFileSync("runs/champions-vgc-2026-reg-mc/analysis/latent-reasoning.jsonl","utf8").trim().split("\n").map(JSON.parse);
if(rows.length<2){console.log("(no previous analysis to diff)");process.exit()}
const [prev,cur]=rows.slice(-2), f=(v,d=3)=>v==null?"—":v.toFixed(d), dl=(a,b)=>a==null||b==null?"—":(b-a>=0?"+":"")+(b-a).toFixed(3);
console.log(`\ndelta analysis #${prev.analysisId} -> #${cur.analysisId} (different fresh seeds; 120 games/policy => win rate noise about ±0.09)`);
for(const e of cur.entries.filter(e=>!e.name.startsWith("ref:"))){const p=prev.entries.find(x=>x.name===e.name); if(!p)continue;
 console.log(`${e.name}: battles ${p.trainingBattles}->${e.trainingBattles} | win ${f(p.winRate)}->${f(e.winRate)} (${dl(p.winRate,e.winRate)}) | agree ${dl(p.agreeArgmax,e.agreeArgmax)} | memΔWR ${f(e.memoryWinDelta)} memTV ${f(e.memoryTV)} | AUCearly ${dl(p.aucEarly,e.aucEarly)} AUCmid ${dl(p.aucMid,e.aucMid)} | focusFire ${f(e.focusFire)} | protectLow ${f(e.protectLow,2)}`)}'
