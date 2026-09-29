"""Small deterministic regression check for the quality gate; no simulator or network."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'agents'))
from quality_gen6 import compare

def report(values, seed=1):
    return dict(pairScores=values, pairs=len(values), startSeed=seed, truncated=0,
                wins=int(2*sum(values)), losses=int(2*(len(values)-sum(values))), draws=0)

original = dict(random=report([1]*200), heuristic=report([.5]*200))
winning = report([1]*140 + [0]*60)
assert compare(original, original, winning)['passed']
assert not compare(original, original, report([.5]*200))['passed']
worse = dict(random=report([.5]*200), heuristic=report([.5]*200))
assert not compare(worse, original, winning)['passed']
assert compare(worse, original, winning)['clearRegression']
try:
    compare(dict(random=report([1]*200, seed=2), heuristic=original['heuristic']), original, winning)
except ValueError:
    pass
else:
    raise AssertionError('Mismatched seed pairing must fail')
print('Quality gate passed: improvement, inconclusive, regression and seed mismatch cases')
