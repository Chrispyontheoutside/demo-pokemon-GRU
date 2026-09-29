"""Evaluate frozen exported policies on held-out, complementary team/seat pairs."""
import argparse
import json
from pathlib import Path
import subprocess
import numpy as np

parser=argparse.ArgumentParser()
parser.add_argument('checkpoint')
parser.add_argument('--pairs',type=int,default=500)
parser.add_argument('--seed',type=int,default=2000000)
parser.add_argument('--output',required=True)
args=parser.parse_args()
if args.pairs < 20:
    parser.error('Use at least 20 pairs for evaluation')
model=json.loads(Path(args.checkpoint).read_text())
requests=[dict(command='evaluate',model=model,pairs=args.pairs,seed=args.seed,opponent=o) for o in ['random','heuristic']]
result=subprocess.run(['node','dist/src/train-worker.js'],input=''.join(json.dumps(r)+'\n' for r in requests),text=True,capture_output=True,check=True)
reports=[json.loads(line) for line in result.stdout.splitlines()]
for report in reports:
    if report['truncated']:
        raise RuntimeError('Evaluation has truncated games; do not report them as losses or draws')
    scores=np.array(report['pairScores'])
    bootstrap=np.random.default_rng(123).choice(scores,(10000,len(scores)),replace=True).mean(1)
    report['score']=float(scores.mean())
    report['paired95ci']=np.quantile(bootstrap,[.025,.975]).tolist()
    print(json.dumps({k:v for k,v in report.items() if k!='pairScores'}),flush=True)
Path(args.output).write_text(json.dumps(dict(checkpoint=args.checkpoint,steps=model['steps'],pairing='same two seeded teams; learner plays each team once in opposite seats',evaluations=reports),indent=2))
