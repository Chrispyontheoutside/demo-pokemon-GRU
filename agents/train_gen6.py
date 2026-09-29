"""Small CPU PPO learner; persistent local Node simulator, export for Node inference."""
import argparse
from collections import deque
from datetime import datetime, timezone
import fcntl
import json
import math
import os
from pathlib import Path
import signal
import shutil
import subprocess
import time
import numpy as np
import torch
from torch import nn
from torch.distributions import Categorical
from quality_gen6 import assess

class Model(nn.Module):
    def __init__(self):
        super().__init__()
        self.trunk = nn.Linear(426, 64)
        self.actor = nn.Linear(64, 32)
        self.critic = nn.Linear(64, 1)
        nn.init.orthogonal_(self.trunk.weight, math.sqrt(2))
        nn.init.orthogonal_(self.actor.weight, 0.01)
        nn.init.orthogonal_(self.critic.weight, 1)
        for layer in [self.trunk, self.actor, self.critic]:
            nn.init.zeros_(layer.bias)

    def forward(self, state, actions, mask):
        hidden = torch.tanh(self.trunk(state))
        logits = (actions * self.actor(hidden).unsqueeze(1)).sum(-1)
        return Categorical(logits=logits.masked_fill(~mask, -1e9)), self.critic(hidden).squeeze(-1)

    def export(self, steps, games):
        return dict(schema=1, format='gen6randombattle', engineVersion='0.11.11',
                    stateDim=426, actionDim=32, steps=steps, games=games,
                    algorithm='PPO with GAE; heuristic imitation warmup',
                    weights={k: v.detach().tolist() for k, v in self.state_dict().items()})


def main():
    parser = argparse.ArgumentParser()
    budget = parser.add_mutually_exclusive_group()
    budget.add_argument('--steps', type=int, default=100000, help='additional PPO decisions against baseline opponents')
    budget.add_argument('--self-play-games', type=int, default=0, help='cumulative completed self-play game target, including resumed self-play')
    parser.add_argument('--warmup', type=int, default=8192)
    parser.add_argument('--seed', type=int, default=1234)
    parser.add_argument('--output', default='models/gen6-policy.json')
    parser.add_argument('--resume', help='trusted local training-state file')
    parser.add_argument('--eval-pairs', type=int, default=50)
    parser.add_argument('--eval-every-games', type=int, default=100000)
    parser.add_argument('--checkpoint-seconds', type=float, default=60)
    parser.add_argument('--quality-reference', help='frozen original JSON checkpoint; requires matching .pt; enables protected champion selection')
    parser.add_argument('--quality-pairs', type=int, default=500)
    args = parser.parse_args()
    if min(args.steps, args.self_play_games, args.warmup, args.eval_pairs, args.eval_every_games, args.checkpoint_seconds) < 0:
        parser.error('counts must be nonnegative')
    if args.self_play_games and not args.resume:
        parser.error('self-play requires an existing local training checkpoint')
    if args.quality_reference and (not args.self_play_games or args.quality_pairs < 100 or not args.eval_every_games):
        parser.error('quality protection requires self-play, periodic evaluation and at least 100 pairs')
    torch.set_num_threads(2)
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    model = Model()
    optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
    total_steps = total_games = 0
    next_seed = args.seed
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    # Prevent two detached trainers from writing the same checkpoint.
    lock = output.with_suffix('.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        parser.error('another trainer is writing this output')
    if output.exists() and (not args.resume or Path(args.resume).resolve() != output.with_suffix('.pt').resolve()):
        parser.error('output already exists; choose a new path or resume its matching .pt checkpoint')
    selfplay_games = completed_games = discarded_games = 0
    last_eval_games = 0
    if args.resume:
        saved = torch.load(args.resume, weights_only=True)
        model.load_state_dict(saved['model'])
        optimizer.load_state_dict(saved['optimizer'])
        total_steps, total_games, next_seed = saved['steps'], saved['games'], saved['next_seed']
        torch.set_rng_state(saved['rng'])
        selfplay_games = saved.get('selfplay_games', 0)
        completed_games = saved.get('completed_games', total_games)
        discarded_games = saved.get('discarded_games', 0)
        last_eval_games = saved.get('last_eval_games', 0)
        args.warmup = 0
        if selfplay_games and not args.self_play_games:
            parser.error('resume this self-play run with --self-play-games and its cumulative target')
        if args.self_play_games and args.self_play_games < selfplay_games:
            parser.error('self-play target is below the checkpoint count')
    stopping = False
    def request_stop(signum, frame):
        nonlocal stopping
        stopping = True  # Finish this update before saving consistent weights/optimizer/counters.
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    worker = subprocess.Popen(['node', 'dist/src/train-worker.js'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)

    def export():
        checkpoint = model.export(total_steps, total_games)
        if args.self_play_games:
            checkpoint.update(algorithm='PPO with GAE; both-seat current-policy self-play, continued from imitation/PPO', selfPlayGames=selfplay_games)
        return checkpoint

    def call(command, **kwargs):
        checkpoint = kwargs.pop('checkpoint', None)
        worker.stdin.write(json.dumps(dict(command=command, model=checkpoint if checkpoint is not None else export(), **kwargs), separators=(',', ':'))+'\n')
        worker.stdin.flush()
        line = worker.stdout.readline()
        if not line:
            raise RuntimeError(f'Simulator worker stopped (exit {worker.poll()})')
        return json.loads(line)

    def save():
        temporary = output.with_suffix('.tmp')
        temporary.write_text(json.dumps(export(), separators=(',', ':')))
        temporary.replace(output)
        state_path = output.with_suffix('.pt')
        temporary_state = state_path.with_suffix('.pt.tmp')
        torch.save(dict(model=model.state_dict(), optimizer=optimizer.state_dict(),
                        steps=total_steps, games=total_games, next_seed=next_seed, rng=torch.get_rng_state(),
                        selfplay_games=selfplay_games, completed_games=completed_games, discarded_games=discarded_games,
                        last_eval_games=last_eval_games), temporary_state)
        temporary_state.replace(state_path)

    def status(state):
        elapsed = time.monotonic() - start
        rate = (selfplay_games - initial_selfplay_games) / elapsed if elapsed else 0
        data = dict(status=state, pid=os.getpid(), workerPid=worker.pid, updatedAt=datetime.now(timezone.utc).isoformat(),
                    checkpoint=str(output), checkpointSelfPlayGames=checkpoint_games,
                    targetSelfPlayGames=args.self_play_games, selfPlayGames=selfplay_games,
                    steps=total_steps, attemptedGames=total_games, completedGames=completed_games,
                    discardedGames=discarded_games, elapsedSeconds=round(elapsed,2), gamesPerSecond=round(rate,3),
                    estimatedRemainingHours=round(max(0,args.self_play_games-selfplay_games)/rate/3600,2) if rate else None,
                    latestMetric=metrics[-1] if metrics else None)
        temporary = output.with_suffix('.status.tmp')
        temporary.write_text(json.dumps(data, indent=2))
        temporary.replace(output.with_suffix('.status.json'))

    quality_dir = output.parent / 'quality'
    quality_state = quality_dir / 'selection.json'
    def copy_atomic(source, destination):
        temporary = destination.with_suffix(destination.suffix + '.tmp')
        shutil.copyfile(source, temporary)
        temporary.replace(destination)

    if args.quality_reference:
        quality_dir.mkdir(exist_ok=True)
        reference = Path(args.quality_reference)
        for name in ['original', 'best']:
            for suffix in ['.json', '.pt']:
                destination = quality_dir / (name + suffix)
                if not destination.exists():
                    copy_atomic(reference.with_suffix(suffix), destination)

    def quality_check():
        save()  # Freeze a matching JSON/optimizer snapshot before evaluating it.
        selection = json.loads(quality_state.read_text()) if quality_state.exists() else {}
        if selection.get('candidateSteps') == total_steps:
            return selection
        check_index = selection.get('checks', 0)
        # Fresh evaluation teams each check, far outside the training seed range.
        seed = 3200000000 + check_index * args.quality_pairs
        original = json.loads((quality_dir / 'original.json').read_text())
        best = json.loads((quality_dir / 'best.json').read_text())
        references = {'best': best}
        if best['weights'] != original['weights']:
            references['original'] = original
        def run(checkpoint, opponent, pairs, seed, opponent_model=None):
            options = dict(checkpoint=checkpoint, opponent=opponent, pairs=pairs, seed=seed)
            if opponent_model is not None:
                options['opponentModel'] = opponent_model
            return call('evaluate', **options)
        result = assess(run, export(), references, pairs=args.quality_pairs, seed=seed)
        if result['promote']:
            for suffix in ['.json', '.pt']:
                # Retain each successful checkpoint, so later selection errors are reversible.
                copy_atomic(output.with_suffix(suffix), quality_dir / (f'accepted-{selfplay_games}' + suffix))
                copy_atomic(output.with_suffix(suffix), quality_dir / ('best' + suffix))
        best_games = selfplay_games if result['promote'] else best.get('selfPlayGames', 0)
        result.update(checks=check_index+1, candidateSteps=total_steps, candidateSelfPlayGames=selfplay_games, bestSelfPlayGames=best_games,
                      checkedAt=datetime.now(timezone.utc).isoformat(),
                      consecutiveRegressions=selection.get('consecutiveRegressions',0)+1 if result['clearRegression'] else 0)
        temporary = quality_state.with_suffix('.tmp')
        temporary.write_text(json.dumps(result, indent=2)); temporary.replace(quality_state)
        print(json.dumps(dict(event='quality-selection', **result)), flush=True)
        return result

    def evaluate():
        evaluations=[]
        for opponent in ['random','heuristic']:
            if args.eval_pairs:
                # Disjoint from the ~20M sequential training seeds, including original evaluation seeds.
                result=call('evaluate',pairs=args.eval_pairs,seed=3000000000,opponent=opponent)
                if result['truncated']:
                    raise RuntimeError('Evaluation has truncated games')
                scores=np.array(result['pairScores'])
                bootstrap=np.random.default_rng(123).choice(scores,(5000,len(scores)),replace=True).mean(1)
                result['score']=float(scores.mean()); result['paired95ci']=np.quantile(bootstrap,[.025,.975]).tolist()
                evaluations.append(result)
                print(json.dumps(dict(event='evaluation',selfPlayGames=selfplay_games,**{k:v for k,v in result.items() if k!='pairScores'})),flush=True)
        if evaluations:
            temporary=output.with_suffix('.evaluation.tmp')
            temporary.write_text(json.dumps(dict(steps=total_steps,selfPlayGames=selfplay_games,evaluations=evaluations),indent=2))
            temporary.replace(output.with_suffix('.evaluation.json'))
        return evaluations

    start = time.monotonic()
    initial_selfplay_games = selfplay_games
    checkpoint_games = selfplay_games
    last_checkpoint = start
    metrics = deque(maxlen=200)
    initial_weights = torch.cat([p.detach().flatten() for p in model.parameters()]).clone()
    ppo_initial_weights = None
    before_evaluation = None
    try:
        # Verify Python training and Node deployment agree before producing rollouts.
        state = np.random.uniform(-1,1,(1,426)).astype('float32')
        actions = np.random.uniform(-1,1,(1,14,32)).astype('float32')
        mask = np.array([[True]*9+[False]*5])
        with torch.no_grad():
            dist, value = model(torch.from_numpy(state),torch.from_numpy(actions),torch.from_numpy(mask))
        prediction = call('predict', encoded=dict(state=state[0].tolist(), actions=actions[0].tolist(), mask=mask[0].tolist()))
        np.testing.assert_allclose(prediction['probabilities'],dist.probs[0].numpy(),atol=1e-6)
        np.testing.assert_allclose(prediction['value'],value.item(),atol=1e-5)
        print(json.dumps(dict(event='inference-parity-passed', parameters=sum(p.numel() for p in model.parameters()), torch=torch.__version__, mps=torch.backends.mps.is_available())),flush=True)
        remaining = args.steps
        warmup = args.warmup
        if args.self_play_games and selfplay_games == 0:
            evaluate()
        if args.quality_reference:
            quality_check()
        save(); status('running')
        while not stopping and (warmup or (selfplay_games < args.self_play_games if args.self_play_games else remaining > 0)):
            teacher = warmup > 0
            collection = dict(steps=warmup if teacher else 2048 if args.self_play_games else min(2048,remaining), seed=next_seed, teacher=teacher)
            if args.self_play_games:
                collection.update(selfPlay=True, maxGames=args.self_play_games-selfplay_games)
            batch = call('collect', **collection)
            next_seed += batch['games']; total_games += batch['games']
            completed_games += batch['completed']; discarded_games += batch['discarded']
            rows, returns, advantages = [], [], []
            for episode in batch['episodes']:
                ep = episode['steps']; gae=0.; next_value=0.
                ep_returns=[]; ep_advantages=[]
                for i in range(len(ep)-1,-1,-1):
                    reward = episode['reward'] if i==len(ep)-1 else 0.
                    delta = reward + 0.99*next_value - ep[i]['value']
                    gae = delta + 0.99*0.95*gae
                    ep_advantages.append(gae); ep_returns.append(gae+ep[i]['value'])
                    next_value=ep[i]['value']
                rows.extend(ep); returns.extend(reversed(ep_returns)); advantages.extend(reversed(ep_advantages))
            states=torch.tensor([r['state'] for r in rows],dtype=torch.float32)
            actions=torch.tensor([r['actions'] for r in rows],dtype=torch.float32)
            masks=torch.tensor([r['mask'] for r in rows],dtype=torch.bool)
            chosen=torch.tensor([r['action'] for r in rows])
            old_logp=torch.tensor([r['logp'] for r in rows])
            targets=torch.tensor(returns,dtype=torch.float32)
            adv=torch.tensor(advantages,dtype=torch.float32)
            adv=(adv-adv.mean())/(adv.std(unbiased=False)+1e-8)
            # Stored rollout probabilities must match this frozen policy before optimization.
            if not teacher:
                with torch.no_grad():
                    check,_=model(states,actions,masks)
                    torch.testing.assert_close(check.log_prob(chosen),old_logp,atol=2e-5,rtol=2e-5)
            losses=[]
            for _ in range(12 if teacher else 4):
                for ix in torch.randperm(len(rows)).split(256):
                    dist, values=model(states[ix],actions[ix],masks[ix])
                    logp=dist.log_prob(chosen[ix])
                    if teacher:
                        loss=-logp.mean()
                    else:
                        ratio=(logp-old_logp[ix]).exp()
                        policy=-torch.minimum(ratio*adv[ix],ratio.clamp(0.8,1.2)*adv[ix]).mean()
                        loss=policy+0.5*(values-targets[ix]).square().mean()-0.01*dist.entropy().mean()
                    if not torch.isfinite(loss):
                        raise RuntimeError('Nonfinite training loss')
                    optimizer.zero_grad(); loss.backward()
                    nn.utils.clip_grad_norm_(model.parameters(),0.5)
                    optimizer.step(); losses.append(loss.item())
            if teacher:
                warmup=0
                ppo_initial_weights = torch.cat([p.detach().flatten() for p in model.parameters()]).clone()
                if args.eval_pairs:
                    before_evaluation = call('evaluate', pairs=args.eval_pairs, seed=1000000, opponent='heuristic')
                    print(json.dumps(dict(event='before-ppo-evaluation', **before_evaluation)), flush=True)
            else:
                remaining-=len(rows); total_steps+=len(rows)
                if args.self_play_games:
                    selfplay_games += batch['completed']
            metric=dict(event='imitation' if teacher else 'ppo', steps=total_steps, games=total_games,
                        selfPlayGames=selfplay_games, completedGames=completed_games,
                        batch_decisions=len(rows), reward=float(np.mean([e['reward'] for e in batch['episodes']])),
                        loss=float(np.mean(losses)), discarded=batch['discarded'], retries=batch['retries'], seconds=round(time.monotonic()-start,2))
            metrics.append(metric); print(json.dumps(metric),flush=True)
            if args.self_play_games and args.eval_every_games and selfplay_games-last_eval_games >= args.eval_every_games:
                evaluate()
                if args.quality_reference:
                    quality_check()
                last_eval_games=selfplay_games
            if time.monotonic()-last_checkpoint >= args.checkpoint_seconds:
                save(); checkpoint_games=selfplay_games; last_checkpoint=time.monotonic()
            status('stopping' if stopping else 'running')
        save(); checkpoint_games=selfplay_games
        change=(torch.cat([p.detach().flatten() for p in model.parameters()])-initial_weights).norm().item()
        ppo_change=(torch.cat([p.detach().flatten() for p in model.parameters()])-(ppo_initial_weights if ppo_initial_weights is not None else initial_weights)).norm().item()
        if not stopping and (selfplay_games > initial_selfplay_games if args.self_play_games else args.steps > 0) and ppo_change == 0:
            raise RuntimeError('Training did not change model parameters')
        evaluations=evaluate() if not stopping else []
        if args.quality_reference and not stopping:
            quality_check()
        report=dict(steps=total_steps,games=total_games,parameterChangeL2=change,ppoParameterChangeL2=ppo_change,beforePpoEvaluation=before_evaluation,elapsedSeconds=time.monotonic()-start,
                    seed=args.seed,imitationDecisions=args.warmup,selfPlayGames=selfplay_games,targetSelfPlayGames=args.self_play_games,
                    completedGames=completed_games,discardedGames=discarded_games,metrics=list(metrics),metricsNote='Last 200 updates; full history in stdout log',evaluations=evaluations)
        output.with_suffix('.training.json').write_text(json.dumps(report,indent=2))
        status('stopped' if stopping else 'complete')
        print(json.dumps(dict(event='stopped' if stopping else 'complete',checkpoint=str(output),steps=total_steps,selfPlayGames=selfplay_games,parameterChangeL2=change)),flush=True)
    except BaseException:
        # The last atomic .pt is authoritative; never overwrite it with a partially applied update.
        status('failed')
        raise
    finally:
        worker.stdin.close()
        try: worker.wait(timeout=5)
        except subprocess.TimeoutExpired:
            worker.terminate(); worker.wait(timeout=5)

if __name__ == '__main__':
    main()
