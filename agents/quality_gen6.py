"""Paired evaluation gates: statistical screening, not a guarantee against every opponent."""
import numpy as np


def interval(values):
    values = np.asarray(values, dtype=float)
    if len(values) < 100 or not np.isfinite(values).all():
        raise ValueError('Quality gates require at least 100 finite paired observations')
    rng = np.random.default_rng(7421)
    # Keep bootstrap memory bounded even with larger evaluation sets.
    means = np.concatenate([rng.choice(values, (200, len(values)), replace=True).mean(1) for _ in range(50)])
    return np.quantile(means, [.005, .995]).tolist()


def scores(report):
    values = report['pairScores']
    if report['truncated'] or len(values) != report['pairs'] or any(v not in [0, .5, 1] for v in values):
        raise ValueError('Incomplete or malformed evaluation cannot pass a quality gate')
    if report['wins'] + report['losses'] + report['draws'] != 2 * len(values):
        raise ValueError('Evaluation game count does not match its pairs')
    return np.asarray(values)


def compare(candidate, reference, head_to_head, tolerance=.03):
    """Require head-to-head improvement and baseline noninferiority within 3 percentage points."""
    head = scores(head_to_head)
    head_ci = interval(head)
    checks = []
    for opponent in ['random', 'heuristic']:
        new, old = candidate[opponent], reference[opponent]
        if (new['startSeed'], new['pairs']) != (old['startSeed'], old['pairs']):
            raise ValueError('Baseline comparisons must use identical seeded pairs')
        delta = scores(new) - scores(old)
        ci = interval(delta)
        checks.append(dict(opponent=opponent, candidateScore=float(scores(new).mean()),
                           referenceScore=float(scores(old).mean()), difference=float(delta.mean()),
                           difference99ci=ci, acceptable=ci[0] >= -tolerance,
                           clearRegression=ci[1] < -tolerance))
    return dict(passed=head_ci[0] > .5 and all(c['acceptable'] for c in checks),
                headToHeadScore=float(head.mean()), headToHead99ci=head_ci,
                tolerance=tolerance, baselines=checks,
                clearRegression=head_ci[1] < .5 or any(c['clearRegression'] for c in checks))


def assess(run, candidate, references, *, pairs, seed):
    """run(checkpoint, opponent, pairs, seed, opponent_model=None) returns paired game results."""
    results = {opponent: run(candidate, opponent, pairs, seed) for opponent in ['random', 'heuristic']}
    comparisons = {}
    for name, reference in references.items():
        old = {opponent: run(reference, opponent, pairs, seed) for opponent in ['random', 'heuristic']}
        head = run(candidate, name, pairs, seed, reference)
        comparisons[name] = compare(results, old, head)
    return dict(promote=all(c['passed'] for c in comparisons.values()), comparisons=comparisons,
                clearRegression=any(c['clearRegression'] for c in comparisons.values()),
                pairs=pairs, seed=seed,
                interpretation='99% paired bootstrap screening intervals per comparison; repeated checks and untested opponents prevent a universal no-regression guarantee')
