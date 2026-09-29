"""Random-init PPO for local Pokémon Champions VGC self-play."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import subprocess
import time

import numpy as np
import torch
from torch import nn
from torch.distributions import Categorical

FORMAT = 'gen9championsvgc2026regmb'
ENGINE = '0.11.11'
STATE_DIM, ACTION_DIM = 800, 56
LEDGER_PATH = Path('reports/champions-vgc-2026-reg-mb/experiment-ledger.json')


class Model(nn.Module):
    def __init__(self, simple_score_weight=0.0):
        super().__init__()
        self.simple_score_weight = simple_score_weight
        self.state = nn.Linear(STATE_DIM, 64)
        self.action = nn.Linear(64, ACTION_DIM)
        self.critic = nn.Linear(64, 1)
        nn.init.orthogonal_(self.state.weight, np.sqrt(2))
        nn.init.orthogonal_(self.action.weight, .01)
        nn.init.orthogonal_(self.critic.weight, 1)
        for layer in (self.state, self.action, self.critic):
            nn.init.zeros_(layer.bias)

    def forward(self, states, actions, mask, simple_scores=None):
        hidden = torch.tanh(self.state(states))
        logits = torch.einsum('bnd,bd->bn', actions, self.action(hidden))
        if simple_scores is not None:
            logits = logits + self.simple_score_weight * simple_scores
        return Categorical(logits=logits.masked_fill(~mask, -1e9)), self.critic(hidden).squeeze(-1)

    def export(self, steps, battles, trained_on, baseline_trained_on=0):
        return dict(schema=1, format=FORMAT, engineVersion=ENGINE, stateDim=STATE_DIM,
                    actionDim=ACTION_DIM, steps=steps, selfPlayBattlesGenerated=battles,
                    selfPlayBattlesUsedForPPO=trained_on,
                    baselineTrainingBattlesUsedForPPO=baseline_trained_on,
                    simpleScoreWeight=self.simple_score_weight,
                    algorithm='random initialization; PPO with GAE; local self-play and generated baseline battles',
                    weights={k: v.detach().cpu().tolist() for k, v in self.state_dict().items()})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--battles', type=int, default=1000, help='cumulative completed training battles against --training-opponent')
    parser.add_argument('--training-opponent', choices=['selfplay','heuristic','random'], default='selfplay')
    parser.add_argument('--seed', type=int, default=20260928)
    parser.add_argument('--output', default='runs/champions-vgc-2026-reg-mb/seed-20260928/policy.json')
    parser.add_argument('--batch-games', type=int, default=8)
    parser.add_argument('--simple-score-weight', type=float, default=0.0)
    parser.add_argument('--max-turns', type=int, default=200)
    parser.add_argument('--debug', action='store_true', help='trace the first 40 decisions per player per battle')
    parser.add_argument('--checkpoint-seconds', type=float, default=30)
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    if args.battles < 1 or args.seed < 0 or args.batch_games < 1 or not np.isfinite(args.simple_score_weight):
        parser.error('battles and batch-games must be positive; seed nonnegative; score weight finite')

    torch.set_num_threads(2)
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    model = Model(args.simple_score_weight)
    optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    state_path = output.with_suffix('.pt')
    started_games = 0
    started_completed = 0
    started_trained_on = 0
    started_attempts = 0
    started_truncated = 0
    started_aborted = 0
    started_baseline_games = started_baseline_completed = started_baseline_trained = 0
    started_baseline_attempts = started_baseline_truncated = started_baseline_aborted = 0
    ledger = json.loads(LEDGER_PATH.read_text()) if LEDGER_PATH.exists() else {}
    ledger_baseline = {name: int(ledger.get(name, 0)) for name in (
        'selfPlayBattlesGenerated', 'selfPlayBattlesCompleted', 'selfPlayBattlesUsedForPPO', 'selfPlayBattleAttempts',
        'selfPlayBattlesTruncated', 'selfPlayBattlesAborted', 'baselineTrainingBattlesGenerated',
        'baselineTrainingBattlesCompleted', 'baselineTrainingBattlesUsedForPPO', 'baselineTrainingBattleAttempts',
        'baselineTrainingBattlesTruncated', 'baselineTrainingBattlesAborted')}
    steps = 0
    next_seed = args.seed
    if args.resume:
        saved = torch.load(state_path, map_location='cpu', weights_only=True)
        model.load_state_dict(saved['model'])
        optimizer.load_state_dict(saved['optimizer'])
        steps, started_games, next_seed = saved['steps'], saved['battlesGenerated'], saved['next_seed']
        started_completed = saved['battlesCompleted']
        started_trained_on = saved.get('trainedOn', 0)
        started_attempts = saved['attempts']
        started_truncated = saved['truncated']
        started_aborted = saved.get('aborted', 0)
        started_baseline_games = saved.get('baselineGenerated', 0)
        started_baseline_completed = saved.get('baselineCompleted', 0)
        started_baseline_trained = saved.get('baselineTrained', 0)
        started_baseline_attempts = saved.get('baselineAttempts', 0)
        started_baseline_truncated = saved.get('baselineTruncated', 0)
        started_baseline_aborted = saved.get('baselineAborted', 0)
        ledger_baseline = saved.get('ledgerBaseline', ledger_baseline)
        status_path = output.with_suffix('.status.json')
        if status_path.exists():
            latest = json.loads(status_path.read_text())
            if latest.get('checkpoint') == str(output):
                started_games = latest.get('runSelfPlayBattlesGenerated', started_games)
                started_completed = latest.get('runSelfPlayBattlesCompleted', started_completed)
                started_trained_on = latest.get('runSelfPlayBattlesUsedForPPO', started_trained_on)
                started_attempts = latest.get('runSelfPlayBattleAttempts', started_attempts)
                started_truncated = latest.get('runTruncatedBattles', started_truncated)
                started_aborted = latest.get('runAbortedBattles', started_aborted)
                started_baseline_games = latest.get('runBaselineTrainingBattlesGenerated', started_baseline_games)
                started_baseline_completed = latest.get('runBaselineTrainingBattlesCompleted', started_baseline_completed)
                started_baseline_trained = latest.get('runBaselineTrainingBattlesUsedForPPO', started_baseline_trained)
                started_baseline_attempts = latest.get('runBaselineTrainingBattleAttempts', started_baseline_attempts)
                started_baseline_truncated = latest.get('runBaselineTrainingBattlesTruncated', started_baseline_truncated)
                started_baseline_aborted = latest.get('runBaselineTrainingBattlesAborted', started_baseline_aborted)
                next_seed = latest.get('nextSeed', next_seed)
                if 'runSelfPlayBattlesUsedForPPO' not in latest:
                    record = next((run for run in ledger.get('runs', []) if run.get('checkpoint') == str(output)), {})
                    started_trained_on = record.get('usedForPPO', started_trained_on)
        for name, current, run_count in [
            ('selfPlayBattlesUsedForPPO', 'selfPlayBattlesUsedForPPO', started_trained_on),
            ('baselineTrainingBattlesGenerated', 'baselineTrainingBattlesGenerated', started_baseline_games),
            ('baselineTrainingBattlesCompleted', 'baselineTrainingBattlesCompleted', started_baseline_completed),
            ('baselineTrainingBattlesUsedForPPO', 'baselineTrainingBattlesUsedForPPO', started_baseline_trained),
            ('baselineTrainingBattleAttempts', 'baselineTrainingBattleAttempts', started_baseline_attempts),
            ('baselineTrainingBattlesTruncated', 'baselineTrainingBattlesTruncated', started_baseline_truncated),
            ('baselineTrainingBattlesAborted', 'baselineTrainingBattlesAborted', started_baseline_aborted),
        ]:
            ledger_baseline.setdefault(name, int(ledger.get(current, 0))-run_count)
        torch.set_rng_state(saved['rng'])
        active_saved = started_completed if args.training_opponent == 'selfplay' else started_baseline_completed
        if args.battles < active_saved:
            parser.error('--battles is below the saved cumulative training battle count for this opponent')
    elif output.exists() or state_path.exists():
        parser.error('output already exists; use --resume or choose another run directory')

    stopping = False
    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    worker = subprocess.Popen(['node', 'dist/src/champions-worker.js'], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, text=True, bufsize=1)
    start_time = time.monotonic()
    last_save = start_time
    battles_generated = started_games
    battles_completed = started_completed
    trained_on = started_trained_on
    baseline_games = started_baseline_games
    baseline_completed = started_baseline_completed
    baseline_trained_on = started_baseline_trained
    baseline_attempts = started_baseline_attempts
    baseline_truncated = started_baseline_truncated
    baseline_aborted = started_baseline_aborted
    truncated_total = started_truncated
    attempts_total = started_attempts
    aborted_total = started_aborted
    inflight = None
    recent = []
    baseline_weights = torch.cat([p.detach().flatten() for p in model.parameters()]).clone()

    def call(command, **kwargs):
        nonlocal battles_generated, attempts_total, next_seed, inflight, battles_completed, truncated_total
        nonlocal baseline_games, baseline_attempts, baseline_completed, baseline_truncated
        payload = dict(command=command, model=model.export(steps, battles_generated, trained_on, baseline_trained_on), **kwargs)
        worker.stdin.write(json.dumps(payload, separators=(',', ':')) + '\n')
        worker.stdin.flush()
        while True:
            line = worker.stdout.readline()
            if not line:
                raise RuntimeError(f'Champions simulator worker exited with {worker.poll()}')
            result = json.loads(line)
            if result.get('event') == 'battle-started':
                if result.get('opponent', 'selfplay') == 'selfplay':
                    battles_generated += 1
                    attempts_total += 1
                else:
                    baseline_games += 1
                    baseline_attempts += 1
                inflight = (result['seed'], result.get('opponent', 'selfplay'))
                next_seed = result['seed'] + 1
                save('running', checkpoint=False)
                continue
            if result.get('event') == 'battle-finished':
                if result.get('opponent', 'selfplay') == 'selfplay':
                    if result['completed']: battles_completed += 1
                    if result['truncated']: truncated_total += 1
                else:
                    if result['completed']: baseline_completed += 1
                    if result['truncated']: baseline_truncated += 1
                inflight = None
                save('running', checkpoint=False)
                continue
            return result

    def save(status='running', checkpoint=True):
        if checkpoint:
            data = model.export(steps, battles_generated, trained_on, baseline_trained_on)
            temporary = output.with_suffix('.json.tmp')
            temporary.write_text(json.dumps(data, separators=(',', ':')))
            temporary.replace(output)
            temp_state = state_path.with_suffix('.pt.tmp')
            torch.save(dict(model=model.state_dict(), optimizer=optimizer.state_dict(), steps=steps,
                            battlesGenerated=battles_generated, battlesCompleted=battles_completed,
                            trainedOn=trained_on, attempts=attempts_total, truncated=truncated_total, aborted=aborted_total,
                            baselineGenerated=baseline_games, baselineCompleted=baseline_completed, baselineTrained=baseline_trained_on,
                            baselineAttempts=baseline_attempts, baselineTruncated=baseline_truncated, baselineAborted=baseline_aborted,
                            ledgerBaseline=ledger_baseline, next_seed=next_seed, rng=torch.get_rng_state()), temp_state)
            temp_state.replace(state_path)
        elapsed = time.monotonic() - start_time
        totals = {
            'selfPlayBattlesGenerated': ledger_baseline['selfPlayBattlesGenerated'] + battles_generated,
            'selfPlayBattlesCompleted': ledger_baseline['selfPlayBattlesCompleted'] + battles_completed,
            'selfPlayBattlesUsedForPPO': ledger_baseline['selfPlayBattlesUsedForPPO'] + trained_on,
            'selfPlayBattleAttempts': ledger_baseline['selfPlayBattleAttempts'] + attempts_total,
            'selfPlayBattlesTruncated': ledger_baseline['selfPlayBattlesTruncated'] + truncated_total,
            'selfPlayBattlesAborted': ledger_baseline['selfPlayBattlesAborted'] + aborted_total,
            'baselineTrainingBattlesGenerated': ledger_baseline['baselineTrainingBattlesGenerated'] + baseline_games,
            'baselineTrainingBattlesCompleted': ledger_baseline['baselineTrainingBattlesCompleted'] + baseline_completed,
            'baselineTrainingBattlesUsedForPPO': ledger_baseline['baselineTrainingBattlesUsedForPPO'] + baseline_trained_on,
            'baselineTrainingBattleAttempts': ledger_baseline['baselineTrainingBattleAttempts'] + baseline_attempts,
            'baselineTrainingBattlesTruncated': ledger_baseline['baselineTrainingBattlesTruncated'] + baseline_truncated,
            'baselineTrainingBattlesAborted': ledger_baseline['baselineTrainingBattlesAborted'] + baseline_aborted,
        }
        progress = dict(status=status, format=FORMAT, engineVersion=ENGINE, seed=args.seed,
                        initialization='random; no demonstration data', device='CPU; Apple M5 / 16 GB host',
                        simpleScoreWeight=args.simple_score_weight,
                        checkpoint=str(output), **totals,
                        runSelfPlayBattlesGenerated=battles_generated, runSelfPlayBattlesCompleted=battles_completed,
                        runSelfPlayBattlesUsedForPPO=trained_on,
                        runSelfPlayBattleAttempts=attempts_total, runTruncatedBattles=truncated_total,
                        runAbortedBattles=aborted_total, nextSeed=next_seed,
                        runBaselineTrainingBattlesGenerated=baseline_games,
                        runBaselineTrainingBattlesCompleted=baseline_completed,
                        runBaselineTrainingBattlesUsedForPPO=baseline_trained_on,
                        runBaselineTrainingBattleAttempts=baseline_attempts,
                        runBaselineTrainingBattlesTruncated=baseline_truncated,
                        runBaselineTrainingBattlesAborted=baseline_aborted,
                        truncatedBattles=totals['selfPlayBattlesTruncated'], decisions=steps, elapsedSeconds=round(elapsed, 2),
                        selfPlayBattlesPerSecond=round((battles_generated-started_games)/elapsed, 3) if elapsed else 0,
                        targetBattles=args.battles, recentUpdates=recent[-20:])
        temp_status = output.with_suffix('.status.tmp')
        temp_status.write_text(json.dumps(progress, indent=2))
        temp_status.replace(output.with_suffix('.status.json'))
        combined = dict(ledger)
        combined.update(totals)
        combined.update(randomThroughputBenchmarkBattles=1000, externalReplayTrainingBattles=0,
                        evaluationBattles=int(ledger.get('evaluationBattles', 0)), lastUpdatedAt=datetime.now(timezone.utc).isoformat())
        runs = list(ledger.get('runs', []))
        run = dict(seed=args.seed, checkpoint=str(output), trainingOpponent=args.training_opponent, generated=battles_generated,
                   completed=battles_completed, usedForPPO=trained_on, truncated=truncated_total, aborted=aborted_total,
                   baselineGenerated=baseline_games, baselineCompleted=baseline_completed,
                   baselineUsedForPPO=baseline_trained_on, result=status, nextSeed=next_seed)
        ix = next((i for i, item in enumerate(runs) if item.get('checkpoint') == str(output)), None)
        if ix is None:
            runs.append(run)
        else:
            runs[ix] = run
        combined['runs'] = runs
        temp_ledger = LEDGER_PATH.with_suffix('.tmp')
        temp_ledger.write_text(json.dumps(combined, indent=2))
        temp_ledger.replace(LEDGER_PATH)

    try:
        # Verify the Python learner and deployable Node checkpoint use identical logits/value.
        state = np.random.uniform(-1, 1, (STATE_DIM,)).astype('float32')
        actions = np.random.uniform(-1, 1, (5, ACTION_DIM)).astype('float32')
        simple_scores = np.random.uniform(0, 5, (5,)).astype('float32')
        with torch.no_grad():
            distribution, value = model(torch.tensor(state)[None], torch.tensor(actions)[None], torch.ones((1,5), dtype=torch.bool), torch.tensor(simple_scores)[None])
        parity = call('predict', encoded=dict(state=state.tolist(), actions=actions.tolist(), simpleScores=simple_scores.tolist()))
        np.testing.assert_allclose(parity['probabilities'], distribution.probs[0].numpy(), atol=2e-5, rtol=2e-5)
        np.testing.assert_allclose(parity['value'], value.item(), atol=2e-5, rtol=2e-5)
        print(json.dumps(dict(event='inference-parity-passed', parameters=sum(p.numel() for p in model.parameters()), torch=torch.__version__)), flush=True)
        save()
        def active_completed():
            return battles_completed if args.training_opponent == 'selfplay' else baseline_completed
        while not stopping and active_completed() < args.battles:
            before_attempts, before_completed, before_truncated = (
                (attempts_total, battles_completed, truncated_total) if args.training_opponent == 'selfplay'
                else (baseline_attempts, baseline_completed, baseline_truncated))
            batch = call('collect', games=min(args.batch_games, args.battles-active_completed()), seed=next_seed,
                         opponent=args.training_opponent, maxTurns=args.max_turns, debug=args.debug)
            after_attempts, after_completed, after_truncated = (
                (attempts_total, battles_completed, truncated_total) if args.training_opponent == 'selfplay'
                else (baseline_attempts, baseline_completed, baseline_truncated))
            if (batch['attempts'] != after_attempts-before_attempts or
                    batch['completed'] != after_completed-before_completed or
                    batch['truncated'] != after_truncated-before_truncated):
                raise RuntimeError('Simulator progress events do not match training batch totals')
            if args.debug:
                print(json.dumps(dict(event='training-diagnostic', opponent=args.training_opponent, generated=batch['attempts'], completed=batch['completed'],
                                      truncated=batch['truncated'], retries=batch['retries'], turnsRemaining=batch['turnsRemaining'])), flush=True)
            rows, returns, advantages = [], [], []
            rewards = []
            for episode in batch['episodes']:
                rewards.append(episode['reward'])
                gae = 0.0
                next_value = 0.0
                ep_returns, ep_advantages = [], []
                for step in reversed(episode['steps']):
                    delta = episode['reward'] + .99 * next_value - step['value']
                    gae = delta + .99 * .95 * gae
                    ep_returns.append(gae + step['value'])
                    ep_advantages.append(gae)
                    next_value = step['value']
                rows.extend(episode['steps'])
                returns.extend(reversed(ep_returns))
                advantages.extend(reversed(ep_advantages))
            if not rows:
                raise RuntimeError('Self-play batch returned no policy decisions')

            states = torch.tensor([row['state'] for row in rows], dtype=torch.float32)
            chosen = torch.tensor([row['action'] for row in rows], dtype=torch.long)
            old_logp = torch.tensor([row['logp'] for row in rows], dtype=torch.float32)
            targets = torch.tensor(returns, dtype=torch.float32)
            adv = torch.tensor(advantages, dtype=torch.float32)
            adv = (adv - adv.mean()) / (adv.std(unbiased=False) + 1e-8)
            # Check saved behavior probabilities before any policy updates.
            with torch.no_grad():
                for start in range(0, len(rows), 32):
                    ix = list(range(start, min(start+32, len(rows))))
                    max_actions = max(len(rows[j]['actions']) for j in ix)
                    action_batch = np.zeros((len(ix), max_actions, ACTION_DIM), dtype=np.float32)
                    score_batch = np.zeros((len(ix), max_actions), dtype=np.float32)
                    mask_batch = np.zeros((len(ix), max_actions), dtype=np.bool_)
                    for k, j in enumerate(ix):
                        n = len(rows[j]['actions'])
                        action_batch[k, :n] = rows[j]['actions']
                        score_batch[k, :n] = rows[j]['simpleScores']
                        mask_batch[k, :n] = True
                    dist, _ = model(states[ix], torch.from_numpy(action_batch), torch.from_numpy(mask_batch), torch.from_numpy(score_batch))
                    torch.testing.assert_close(dist.log_prob(chosen[ix]), old_logp[ix], atol=3e-5, rtol=3e-5)

            losses = []
            for _ in range(4):
                for ix in torch.randperm(len(rows)).split(32):
                    ids = ix.tolist()
                    max_actions = max(len(rows[j]['actions']) for j in ids)
                    action_batch = np.zeros((len(ids), max_actions, ACTION_DIM), dtype=np.float32)
                    score_batch = np.zeros((len(ids), max_actions), dtype=np.float32)
                    mask_batch = np.zeros((len(ids), max_actions), dtype=np.bool_)
                    for k, j in enumerate(ids):
                        n = len(rows[j]['actions'])
                        action_batch[k, :n] = rows[j]['actions']
                        score_batch[k, :n] = rows[j]['simpleScores']
                        mask_batch[k, :n] = True
                    dist, values = model(states[ix], torch.from_numpy(action_batch), torch.from_numpy(mask_batch), torch.from_numpy(score_batch))
                    logp = dist.log_prob(chosen[ix])
                    ratio = (logp - old_logp[ix]).exp()
                    policy_loss = -torch.minimum(ratio*adv[ix], ratio.clamp(.8,1.2)*adv[ix]).mean()
                    loss = policy_loss + .5*(values-targets[ix]).square().mean() - .01*dist.entropy().mean()
                    if not torch.isfinite(loss):
                        raise RuntimeError('Nonfinite PPO loss')
                    optimizer.zero_grad()
                    loss.backward()
                    nn.utils.clip_grad_norm_(model.parameters(), .5)
                    optimizer.step()
                    losses.append(float(loss.item()))
            steps += len(rows)
            if args.training_opponent == 'selfplay':
                trained_on += batch['completed']
            else:
                baseline_trained_on += batch['completed']
            update = dict(event=f'ppo-{args.training_opponent}', selfPlayBattlesGenerated=battles_generated,
                          baselineTrainingBattlesGenerated=baseline_games,
                          selfPlayBattlesCompleted=battles_completed, decisions=steps,
                          selfPlayBattlesUsedForPPO=trained_on,
                          batchDecisions=len(rows), meanReward=float(np.mean(rewards)),
                          loss=float(np.mean(losses)), attempts=batch['attempts'], truncated=batch['truncated'],
                          retries=batch['retries'], elapsedSeconds=round(time.monotonic()-start_time,2))
            recent.append(update)
            print(json.dumps(update), flush=True)
            save('running')
            if time.monotonic() - last_save >= args.checkpoint_seconds:
                save('running')
                last_save = time.monotonic()
        save('stopping' if stopping else 'complete')
        parameter_change = (torch.cat([p.detach().flatten() for p in model.parameters()])-baseline_weights).norm().item()
        report = dict(status='stopped' if stopping else 'complete', format=FORMAT, engineVersion=ENGINE,
                      seed=args.seed, trainingOpponent=args.training_opponent,
                      simpleScoreWeight=args.simple_score_weight,
                      initialization='random; no demonstration data', algorithm='PPO with GAE; local self-play and generated baseline battles',
                      selfPlayBattlesGenerated=battles_generated, selfPlayBattlesCompleted=battles_completed,
                      selfPlayBattlesUsedForPPO=trained_on,
                      baselineTrainingBattlesGenerated=baseline_games,
                      baselineTrainingBattlesCompleted=baseline_completed,
                      baselineTrainingBattlesUsedForPPO=baseline_trained_on,
                      selfPlayBattleAttempts=attempts_total, truncatedBattles=truncated_total,
                      decisions=steps, parameterChangeL2=parameter_change,
                      elapsedSeconds=round(time.monotonic()-start_time,2), updates=recent)
        output.with_suffix('.training.json').write_text(json.dumps(report, indent=2))
        print(json.dumps(dict(event=report['status'], checkpoint=str(output), selfPlayBattlesGenerated=battles_generated,
                              selfPlayBattlesCompleted=battles_completed, selfPlayBattlesUsedForPPO=trained_on,
                              decisions=steps, parameterChangeL2=parameter_change)), flush=True)
    except BaseException:
        if inflight is not None:
            if inflight[1] == 'selfplay': aborted_total += 1
            else: baseline_aborted += 1
            inflight = None
        save('failed')
        raise
    finally:
        worker.stdin.close()
        try:
            worker.wait(timeout=5)
        except subprocess.TimeoutExpired:
            worker.terminate()
            worker.wait(timeout=5)


if __name__ == '__main__':
    main()
