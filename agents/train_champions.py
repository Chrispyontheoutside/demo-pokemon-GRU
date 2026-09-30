"""Random-init PPO for local Pokémon Champions VGC self-play."""
import argparse
import base64
import hashlib
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import threading
import time

import numpy as np
import torch
from torch import nn
from torch.distributions import Categorical

FORMAT = 'gen9championsvgc2026regmc'
ENGINE = '0.11.11+a5df8274'
TEAM_GENERATOR = 'm-c-statpoints-v1'
STATE_DIM, ACTION_DIM = 800, 56
LEGACY_SHARED_LEDGER = Path('reports/champions-vgc-2026-reg-mc/experiment-ledger.json')  # frozen history; pass --ledger to append to it
GAMMA, GAE_LAMBDA = .99, .95
VALUE_LOSS_COEF, ENTROPY_COEF = .5, .01


TF_TOKENS, TF_GLOBAL, TF_MON = 13, 32, 64   # 1 global token + 6 own + 6 opposing Pokémon (layout of packState)
TF_D, TF_HEADS, TF_FF = 64, 4, 128


class TransformerBlock(nn.Module):
    """Pre-LayerNorm block: x + Attn(LN(x)); x + FFN(LN(x)), ReLU FFN. Written out explicitly so Node inference matches exactly."""

    def __init__(self):
        super().__init__()
        self.ln1 = nn.LayerNorm(TF_D)
        self.qkv = nn.Linear(TF_D, 3 * TF_D)
        self.proj = nn.Linear(TF_D, TF_D)
        self.ln2 = nn.LayerNorm(TF_D)
        self.ff1 = nn.Linear(TF_D, TF_FF)
        self.ff2 = nn.Linear(TF_FF, TF_D)

    def forward(self, x):
        n, t, _ = x.shape
        q, k, v = self.qkv(self.ln1(x)).chunk(3, dim=-1)
        split = lambda z: z.reshape(n, t, TF_HEADS, TF_D // TF_HEADS).transpose(1, 2)
        weights = torch.softmax(split(q) @ split(k).transpose(-1, -2) / np.sqrt(TF_D // TF_HEADS), dim=-1)
        x = x + self.proj((weights @ split(v)).transpose(1, 2).reshape(n, t, TF_D))
        return x + self.ff2(torch.relu(self.ff1(self.ln2(x))))


class EntityTransformer(nn.Module):
    """Global token + 12 Pokémon tokens -> pooled representation of width `hidden` (replaces the flat state layer)."""

    def __init__(self, hidden, layers):
        super().__init__()
        self.tok_global = nn.Linear(TF_GLOBAL, TF_D)
        self.tok_mon = nn.Linear(TF_MON, TF_D)
        self.pos = nn.Parameter(torch.randn(TF_TOKENS, TF_D) * .02)
        for i in range(layers):
            self.add_module(f'enc{i}', TransformerBlock())
        self.layer_count = layers
        self.pool = nn.Linear(2 * TF_D, hidden)

    def forward(self, x):
        n = x.shape[0]
        tokens = torch.cat([self.tok_global(x[:, :TF_GLOBAL])[:, None], self.tok_mon(x[:, TF_GLOBAL:].reshape(n, 12, TF_MON))], dim=1) + self.pos
        for i in range(self.layer_count):
            tokens = getattr(self, f'enc{i}')(tokens)
        return torch.tanh(self.pool(torch.cat([tokens[:, 0], tokens[:, 1:].mean(dim=1)], dim=-1)))


class Model(nn.Module):
    def __init__(self, simple_score_weight=0.0, heuristic_imitation_weight=0.0,
                 initialization='fresh random weights; no demonstration data', recurrent=False, hidden=64, depth=1,
                 trunk='mlp', tf_layers=2, joint_head=False):
        super().__init__()
        self.hidden_size = hidden
        self.depth = depth
        self.trunk = trunk
        self.tf_layers = tf_layers
        self.joint_head = joint_head
        self.simple_score_weight = simple_score_weight
        self.heuristic_imitation_weight = heuristic_imitation_weight
        self.initialization = initialization
        self.recurrent = recurrent
        self.opponent_counts = {}
        self.exploration = 0.0   # training-time switch exploration mixture (0 = off)
        if trunk == 'transformer':
            self.encoder = EntityTransformer(hidden, tf_layers)
        else:
            self.state = nn.Linear(STATE_DIM, hidden)
        self.action = nn.Linear(ACTION_DIM, hidden)
        self.score = nn.Linear(hidden, 1)
        self.critic = nn.Linear(hidden, 1)
        if trunk != 'transformer':
            nn.init.orthogonal_(self.state.weight, np.sqrt(2))
        nn.init.orthogonal_(self.action.weight, np.sqrt(2))
        nn.init.orthogonal_(self.score.weight, .01)
        nn.init.orthogonal_(self.critic.weight, 1)
        for layer in ((self.action, self.score, self.critic) if trunk == 'transformer' else (self.state, self.action, self.score, self.critic)):
            nn.init.zeros_(layer.bias)
        if recurrent:
            # Created last so feed-forward parameters draw the same initial values as the v3 control.
            self.memory = nn.GRUCell(hidden, hidden)
        if depth >= 2 and trunk != 'transformer':
            # Extra state layer, created last so default-shape models draw exactly the same initial weights as before.
            self.state2 = nn.Linear(hidden, hidden)
            nn.init.orthogonal_(self.state2.weight, np.sqrt(2))
            nn.init.zeros_(self.state2.bias)
        if joint_head:
            self.joint_hidden = nn.Linear(hidden, hidden)
            self.joint_score = nn.Linear(hidden, 1)
            nn.init.zeros_(self.joint_score.weight)
            nn.init.zeros_(self.joint_score.bias)

    def hidden_sequence(self, states):
        """states: [batch, time, STATE_DIM] -> [batch, time, 64]; recurrent memory starts at zero per battle side."""
        if self.trunk == 'transformer':
            b, t, _ = states.shape
            features = self.encoder(states.reshape(b * t, -1)).reshape(b, t, -1)
        else:
            features = torch.tanh(self.state(states))
            if self.depth >= 2:
                features = torch.tanh(self.state2(features))
        if not self.recurrent:
            return features
        memory = torch.zeros(features.shape[0], features.shape[2])
        outputs = []
        for t in range(features.shape[1]):
            memory = self.memory(features[:, t], memory)
            outputs.append(memory)
        return torch.stack(outputs, dim=1)

    def heads(self, hidden, actions, mask, simple_scores=None):
        action_hidden = torch.tanh(self.action(actions) + hidden.unsqueeze(1))
        logits = self.score(action_hidden).squeeze(-1)
        if self.joint_head:
            logits = logits + self.joint_score(torch.tanh(self.joint_hidden(action_hidden))).squeeze(-1)
        if simple_scores is not None:
            logits = logits + self.simple_score_weight * simple_scores
        values = torch.tanh(self.critic(hidden).squeeze(-1))
        masked = logits.masked_fill(~mask, -1e9)
        if self.exploration > 0:
            # Behaviour policy = (1-eps) * policy + eps * uniform over voluntary-switch candidates (slot switch flags at features 1 and 25).
            probs = torch.softmax(masked, dim=-1)
            switch = ((actions[..., 1] > .5) | (actions[..., 25] > .5)) & mask
            total = switch.sum(-1, keepdim=True)
            uniform_switch = torch.where(total > 0, switch.float() / total.clamp(min=1), probs)
            return Categorical(probs=(1 - self.exploration) * probs + self.exploration * uniform_switch), values
        return Categorical(logits=masked), values

    def forward(self, states, actions, mask, simple_scores=None):
        """Single-decision forward; a recurrent model treats every row as the first decision of a battle."""
        return self.heads(self.hidden_sequence(states.unsqueeze(1))[:, 0], actions, mask, simple_scores)

    def forward_episodes(self, states, actions, mask, simple_scores, lengths):
        """Padded [episode, time, ...] tensors -> distribution/values over the valid rows, in episode-major order."""
        hidden = self.hidden_sequence(states)
        valid = torch.arange(states.shape[1])[None, :] < lengths[:, None]
        return self.heads(hidden[valid], actions[valid], mask[valid], simple_scores[valid])

    def export(self, steps, battles, trained_on, baseline_trained_on=0, with_weights=True):
        return dict(schema=1, format=FORMAT, engineVersion=ENGINE, teamGeneratorVersion=TEAM_GENERATOR,
                    modelArchitecture=(('candidate-conditioned-gru-v3-transformer' if self.recurrent else 'candidate-conditioned-v5-transformer')
                                       if self.trunk == 'transformer' else
                                       ('candidate-conditioned-gru-v1' if self.recurrent else 'candidate-conditioned-v3')
                                       if (self.hidden_size, self.depth) == (64, 1)
                                       else ('candidate-conditioned-gru-v2' if self.recurrent else 'candidate-conditioned-v4')),
                    hiddenSize=self.hidden_size, depth=self.depth, trunk=self.trunk, transformerLayers=self.tf_layers,
                    transformerHeads=TF_HEADS, switchExploration=self.exploration,
                    stateDim=STATE_DIM,
                    actionDim=ACTION_DIM, steps=steps, selfPlayBattlesGenerated=battles,
                    selfPlayBattlesUsedForPPO=trained_on,
                    baselineTrainingBattlesUsedForPPO=baseline_trained_on,
                    trainingOpponentBattles=dict(self.opponent_counts),
                    simpleScoreWeight=self.simple_score_weight,
                    jointHeadResidual=self.joint_head,
                    heuristicImitationWeight=self.heuristic_imitation_weight,
                    initialization=self.initialization,
                    algorithm='PPO with terminal-only GAE and optional local heuristic-action loss',
                    weights={k: v.detach().cpu().tolist() for k, v in self.state_dict().items()} if with_weights else {})

    def weights_b64(self):
        """Exact float32 weights as base64: Node widens each float32 to the same double the JSON path produced."""
        return {k: dict(shape=list(v.shape), data=base64.b64encode(v.detach().cpu().numpy().astype('<f4').tobytes()).decode('ascii'))
                for k, v in self.state_dict().items()}


class WorkerPool:
    """Persistent Node simulator processes. Every request carries one frozen policy version; results echo it back."""

    def __init__(self, count):
        self.procs = [subprocess.Popen(['node', 'dist/src/champions-worker.js'], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, text=True, bufsize=1) for _ in range(count)]
        self.results = queue.Queue()
        self.sent_version = [None] * count
        self.sent_pool = [None] * count
        self.sent_teams = [None] * count
        self.threads = [threading.Thread(target=self._read, args=(k,), daemon=True) for k in range(count)]
        for thread in self.threads:
            thread.start()

    def _read(self, k):
        for line in self.procs[k].stdout:
            self.results.put((k, json.loads(line), time.perf_counter()))
        self.results.put((k, None, time.perf_counter()))

    def collect(self, model_line, version, seed, indices, opponent, max_turns, concurrency, timers, kind_of=None, pool_key=None, pool_line=None, teams=None):
        """Dynamically assign `indices` in chunks of `concurrency`; return per-index results sorted by index."""
        pending = list(indices)
        chunk = max(1, concurrency)
        outstanding = {}
        gathered = []
        def send(k):
            if not pending:
                return
            take, pending[:] = pending[:chunk], pending[chunk:]
            rest = dict(command='collectSlice', policyVersion=version, seed=seed, indices=take, opponent=opponent,
                        maxTurns=max_turns, concurrency=concurrency)
            if teams:
                # Team sets can be large (hundreds of packed teams); a worker receives them once per key and caches them.
                teams_key = hashlib.sha256(json.dumps(teams, sort_keys=True).encode()).hexdigest()[:16]
                rest['teamsKey'] = teams_key
                if self.sent_teams[k] != teams_key:
                    rest['teams'] = teams
                    self.sent_teams[k] = teams_key
            if kind_of:
                rest['kinds'] = [kind_of[i] for i in take]
                rest['poolKey'] = pool_key
            attach_pool = bool(kind_of) and pool_line and self.sent_pool[k] != pool_key and any(kind.startswith('pool:') for kind in rest['kinds'])
            start = time.perf_counter()
            if self.sent_version[k] != version:
                line = json.dumps(rest, separators=(',', ':'))[:-1] + ',' + model_line + '}'
                self.sent_version[k] = version
            else:
                line = json.dumps(rest, separators=(',', ':'))
            if attach_pool:
                line = line[:-1] + ',' + pool_line + '}'
                self.sent_pool[k] = pool_key
            self.procs[k].stdin.write(line + '\n')
            self.procs[k].stdin.flush()
            timers['send'] += time.perf_counter() - start
            outstanding[k] = time.perf_counter()
        for k in range(len(self.procs)):
            send(k)
        while outstanding:
            k, message, arrived = self.results.get()
            if message is None:
                raise RuntimeError(f'Champions simulator worker {k} exited with {self.procs[k].poll()}')
            if message.get('event') != 'slice-finished' or message.get('policyVersion') != version:
                raise RuntimeError(f'Worker {k} returned a result for the wrong policy version or event: {message.get("event")}')
            timers['worker_wall'] += message['wallMs'] / 1000
            timers['round_trip'] += arrived - outstanding.pop(k)
            for key, value in message['profile'].items():
                timers[key] += value
            gathered.extend(message['results'])
            send(k)
        gathered.sort(key=lambda item: item['index'])
        return gathered

    def close(self):
        for proc in self.procs:
            try:
                proc.stdin.close()
            except Exception:
                pass
        for proc in self.procs:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.terminate()
                proc.wait(timeout=5)


def compute_gae(episode, gamma=.99, gae_lambda=.95, shaping=0.0):
    steps = episode['steps']
    # Potential-based shaping F_t = gamma*phi(s_{t+1}) - phi(s_t), phi(terminal) = 0: policy-invariant, densifies credit.
    phis = [shaping * step.get('potential', 0.0) for step in steps]
    returns = [0.0] * len(steps)
    advantages = [0.0] * len(steps)
    gae = next_value = 0.0
    for index in range(len(steps)-1, -1, -1):
        reward = episode['reward'] if index == len(steps)-1 else 0.0
        if shaping:
            reward += gamma * (phis[index+1] if index+1 < len(steps) else 0.0) - phis[index]
        delta = reward + gamma * next_value - steps[index]['value']
        gae = delta + gamma * gae_lambda * gae
        returns[index] = gae + steps[index]['value']
        advantages[index] = gae
        next_value = steps[index]['value']
    return returns, advantages


def pad_rows(rows, states, groups):
    """Pad row groups (one group per battle side, in decision order) into [group, time, ...] tensors."""
    lengths = torch.tensor([len(group) for group in groups])
    time_steps = int(lengths.max())
    max_actions = max(len(rows[j]['actions']) for group in groups for j in group)
    state_batch = torch.zeros((len(groups), time_steps, STATE_DIM))
    action_batch = np.zeros((len(groups), time_steps, max_actions, ACTION_DIM), dtype=np.float32)
    score_batch = np.zeros((len(groups), time_steps, max_actions), dtype=np.float32)
    mask_batch = np.zeros((len(groups), time_steps, max_actions), dtype=np.bool_)
    for k, group in enumerate(groups):
        state_batch[k, :len(group)] = states[group]
        for t, j in enumerate(group):
            n = len(rows[j]['actions'])
            action_batch[k, t, :n] = rows[j]['actions']
            score_batch[k, t, :n] = rows[j]['simpleScores']
            mask_batch[k, t, :n] = True
    return (state_batch, torch.from_numpy(action_batch), torch.from_numpy(mask_batch),
            torch.from_numpy(score_batch), lengths)


def training_log_probs(model, states, actions, mask, simple_scores, chosen):
    distribution, _ = model(states, actions, mask, simple_scores)
    return distribution.log_prob(chosen)


def ppo_ratio(new_logp, old_logp):
    return (new_logp - old_logp).exp()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--battles', type=int, default=1000, help='cumulative completed training battles against --training-opponent')
    parser.add_argument('--training-opponent', choices=['selfplay','heuristic','random','mix'], default='selfplay')
    parser.add_argument('--opponent-mix', help='with --training-opponent mix: kind=weight list, e.g. heuristic=0.3,selfplay=0.3,pool=0.4')
    parser.add_argument('--learner-teams', help='comma-separated team JSON files ({"pack": ...}); the learner (and both self-play seats) use these teams')
    parser.add_argument('--opponent-teams', help='optional team JSON files used for about half of non-self-play opponents (others stay randomly generated)')
    parser.add_argument('--opponent-team-share', type=float, default=0.5, help='share of non-self-play battles whose opposing side plays one of --opponent-teams (rest: generated teams)')
    parser.add_argument('--pool', help='comma-separated frozen checkpoint JSON files used as historical opponents for the "pool" kind')
    parser.add_argument('--seed', type=int, default=20260928)
    parser.add_argument('--output', default='runs/champions-vgc-2026-reg-mc/seed-20260929/policy.json')
    parser.add_argument('--learning-rate', type=float, default=3e-4)
    parser.add_argument('--joint-head', action='store_true', help='add a zero-initialized residual action/context scoring head')
    parser.add_argument('--batch-games', type=int, default=8)
    parser.add_argument('--simple-score-weight', type=float, default=0.0)
    parser.add_argument('--heuristic-imitation-weight', type=float, default=0.0,
                        help='local auxiliary cross-entropy weight toward the fixed heuristic action; default 0')
    parser.add_argument('--architecture', choices=['feedforward', 'gru'], default='feedforward',
                        help='feedforward = candidate-conditioned-v3 control; gru = same network plus one 64-unit GRU cell')
    parser.add_argument('--workers', type=int, default=1, help='persistent Node simulator processes used per rollout batch')
    parser.add_argument('--concurrency', type=int, default=1, help='battles in flight per simulator worker')
    parser.add_argument('--torch-threads', type=int, default=1,
                        help='threads for PPO updates; results are thread-count invariant, and 1 avoids oversubscribing simulator cores')
    parser.add_argument('--legacy-collect', action='store_true',
                        help='use the original single-worker streaming collect command (reference path)')
    parser.add_argument('--ledger', help='ledger file for this experiment; default <output>.ledger.json')
    parser.add_argument('--shaping', type=float, default=0.0, help='coefficient of potential-based HP-difference shaping (0 = terminal reward only)')
    parser.add_argument('--switch-exploration', type=float, default=0.0, help='training-only: mix this much probability uniformly over voluntary-switch candidates in the behaviour policy')
    parser.add_argument('--hidden', type=int, default=64, help='hidden width of the shared representation (64 = original)')
    parser.add_argument('--trunk', choices=['mlp', 'transformer'], default='mlp', help='transformer = entity transformer over 13 tokens (global + 12 Pokémon)')
    parser.add_argument('--tf-layers', type=int, default=2)
    parser.add_argument('--depth', type=int, choices=[1, 2], default=1, help='state layers before memory/heads (1 = original)')
    parser.add_argument('--max-turns', type=int, default=200)
    parser.add_argument('--debug', action='store_true', help='trace the first 40 decisions per player per battle')
    parser.add_argument('--checkpoint-seconds', type=float, default=30)
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--init-from', help='initialize a fresh optimizer from a frozen checkpoint JSON')
    args = parser.parse_args()
    if args.resume and args.init_from:
        parser.error('--resume and --init-from are mutually exclusive')
    team_sets = {}
    for key, value in (('learner', args.learner_teams), ('opponent', args.opponent_teams)):
        if value:
            team_sets[key] = [json.loads(Path(path).read_text())['pack'] for path in value.split(',') if path]
    if team_sets and (args.legacy_collect or args.debug or 'learner' not in team_sets):
        parser.error('team sets need --learner-teams and the worker pool (no --legacy-collect/--debug)')
    # --pool entries are "checkpoint.json" or "checkpoint.json@team.json"; a pool policy with a team always plays that team.
    pool_paths, pool_native_teams = [], {}
    for entry in (args.pool or '').split(','):
        if not entry:
            continue
        checkpoint_path, _, team_path = entry.partition('@')
        pool_paths.append(checkpoint_path)
        if team_path:
            pool_native_teams[hashlib.sha256(Path(checkpoint_path).read_bytes()).hexdigest()[:12]] = json.loads(Path(team_path).read_text())['pack']
    if pool_native_teams:
        team_sets['poolTeams'] = pool_native_teams
    if team_sets and 'opponent' in team_sets:
        team_sets['opponentShare'] = args.opponent_team_share
    mix_weights = {}
    if args.training_opponent == 'mix':
        try:
            mix_weights = {kind: float(weight) for kind, weight in (item.split('=') for item in (args.opponent_mix or '').split(','))}
        except ValueError:
            parser.error('--opponent-mix must look like heuristic=0.3,selfplay=0.3,pool=0.4')
        if (not mix_weights or any(kind not in ('heuristic', 'heuristic2', 'human', 'search', 'random', 'selfplay', 'pool') or weight <= 0 for kind, weight in mix_weights.items())
                or ('pool' in mix_weights) != bool(pool_paths) or args.legacy_collect or args.debug):
            parser.error('mix needs positive weights over heuristic/random/selfplay/pool, --pool iff pool is mixed, and the worker pool (no --legacy-collect/--debug)')
    elif args.opponent_mix or pool_paths:
        parser.error('--opponent-mix and --pool require --training-opponent mix')
    if args.workers < 1 or args.concurrency < 1 or args.torch_threads < 1:
        parser.error('workers, concurrency and torch-threads must be positive')
    if (args.battles < 1 or args.seed < 0 or args.batch_games < 1 or not np.isfinite(args.learning_rate) or args.learning_rate <= 0 or
            not np.isfinite(args.simple_score_weight) or not np.isfinite(args.heuristic_imitation_weight) or
            args.heuristic_imitation_weight < 0):
        parser.error('battles and batch-games must be positive; seed nonnegative; score weight finite; imitation weight finite and nonnegative')

    torch.set_num_threads(args.torch_threads)
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    initialization = ('fresh random weights; no demonstration data' if not args.init_from and not args.resume else
                      f'local checkpoint {args.init_from}; fresh optimizer' if args.init_from else
                      f'resumed checkpoint {args.output}')
    model = Model(args.simple_score_weight, args.heuristic_imitation_weight, initialization,
                  recurrent=args.architecture == 'gru', hidden=args.hidden, depth=args.depth,
                  trunk=args.trunk, tf_layers=args.tf_layers, joint_head=args.joint_head)
    model.exploration = args.switch_exploration
    optimizer = torch.optim.Adam(model.parameters(), lr=args.learning_rate)
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
    critic_reinitialized = False
    ledger_path = Path(args.ledger) if args.ledger else output.with_suffix('.ledger.json')
    ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else {}
    ledger_baseline = {name: int(ledger.get(name, 0)) for name in (
        'selfPlayBattlesGenerated', 'selfPlayBattlesCompleted', 'selfPlayBattlesUsedForPPO', 'selfPlayBattleAttempts',
        'selfPlayBattlesTruncated', 'selfPlayBattlesAborted', 'baselineTrainingBattlesGenerated',
        'baselineTrainingBattlesCompleted', 'baselineTrainingBattlesUsedForPPO', 'baselineTrainingBattleAttempts',
        'baselineTrainingBattlesTruncated', 'baselineTrainingBattlesAborted')}
    steps = 0
    next_seed = args.seed
    if args.init_from:
        parent = json.loads(Path(args.init_from).read_text())
        if (parent.get('format') != FORMAT or parent.get('engineVersion') != ENGINE or
                parent.get('stateDim') != STATE_DIM or parent.get('actionDim') != ACTION_DIM or
                parent.get('modelArchitecture') not in ('candidate-conditioned-v2', 'candidate-conditioned-v3',
                                                        'candidate-conditioned-gru-v1', 'candidate-conditioned-v4',
                                                        'candidate-conditioned-gru-v2', 'candidate-conditioned-v5-transformer',
                                                        'candidate-conditioned-gru-v3-transformer') or
                ('gru' in parent.get('modelArchitecture')) != model.recurrent or
                (parent.get('hiddenSize', 64), parent.get('depth', 1), parent.get('trunk', 'mlp')) != (model.hidden_size, model.depth, model.trunk)):
            parser.error('--init-from checkpoint is incompatible with this M-C policy')
        if parent.get('jointHeadResidual', False) and not args.joint_head:
            parser.error('parent has a residual joint head; pass --joint-head')
        initial_weights = {name: torch.tensor(value, dtype=torch.float32) for name, value in parent['weights'].items()}
        if args.joint_head and not parent.get('jointHeadResidual', False):
            initial_weights.update({name: value for name, value in model.state_dict().items() if name.startswith('joint_')})
        model.load_state_dict(initial_weights, strict=True)
        if parent.get('modelArchitecture') == 'candidate-conditioned-v2':
            # v2 critics were fit against returns corrupted by repeated terminal rewards.
            with torch.no_grad():
                model.critic.weight.zero_()
                model.critic.bias.zero_()
            critic_reinitialized = True
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
        model.opponent_counts = dict(saved.get('opponentCounts', {}))
        status_path = output.with_suffix('.status.json')
        same_run = False
        if status_path.exists():
            latest = json.loads(status_path.read_text())
            if latest.get('checkpoint') == str(output):
                same_run = True
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
        if not same_run:
            # Forked checkpoints already contribute their saved counts to the current experiment ledger.
            ledger_baseline = {
                'selfPlayBattlesGenerated': int(ledger.get('selfPlayBattlesGenerated', 0))-started_games,
                'selfPlayBattlesCompleted': int(ledger.get('selfPlayBattlesCompleted', 0))-started_completed,
                'selfPlayBattlesUsedForPPO': int(ledger.get('selfPlayBattlesUsedForPPO', 0))-started_trained_on,
                'selfPlayBattleAttempts': int(ledger.get('selfPlayBattleAttempts', 0))-started_attempts,
                'selfPlayBattlesTruncated': int(ledger.get('selfPlayBattlesTruncated', 0))-started_truncated,
                'selfPlayBattlesAborted': int(ledger.get('selfPlayBattlesAborted', 0))-started_aborted,
                'baselineTrainingBattlesGenerated': int(ledger.get('baselineTrainingBattlesGenerated', 0))-started_baseline_games,
                'baselineTrainingBattlesCompleted': int(ledger.get('baselineTrainingBattlesCompleted', 0))-started_baseline_completed,
                'baselineTrainingBattlesUsedForPPO': int(ledger.get('baselineTrainingBattlesUsedForPPO', 0))-started_baseline_trained,
                'baselineTrainingBattleAttempts': int(ledger.get('baselineTrainingBattleAttempts', 0))-started_baseline_attempts,
                'baselineTrainingBattlesTruncated': int(ledger.get('baselineTrainingBattlesTruncated', 0))-started_baseline_truncated,
                'baselineTrainingBattlesAborted': int(ledger.get('baselineTrainingBattlesAborted', 0))-started_baseline_aborted,
            }
            if output.exists():
                parent = json.loads(output.read_text())
                if parent.get('modelArchitecture') == 'candidate-conditioned-v2':
                    # v2's critic learned targets corrupted by repeated terminal rewards.
                    with torch.no_grad():
                        model.critic.weight.zero_()
                        model.critic.bias.zero_()
                    optimizer.state.pop(model.critic.weight, None)
                    optimizer.state.pop(model.critic.bias, None)
                    critic_reinitialized = True
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
        active_saved = (started_completed + started_baseline_completed if args.training_opponent == 'mix'
                        else started_completed if args.training_opponent == 'selfplay' else started_baseline_completed)
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

    pool = None if args.legacy_collect else WorkerPool(args.workers)
    # Legacy streaming path and the startup parity check both use one dedicated simulator process.
    worker = subprocess.Popen(['node', 'dist/src/champions-worker.js'], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, text=True, bufsize=1)
    timers = {key: 0.0 for key in ('send', 'worker_wall', 'round_trip', 'serialize', 'collect_wall', 'ppo', 'prep',
                                   'encodeMs', 'encodeCalls', 'chooseMs', 'chooseCalls', 'policyParseMs', 'policyParseCalls')}
    policy_version = 0
    pending_attempts = 0
    pending_self = 0
    opponent_counts = {}
    pool_names, pool_key, pool_line = [], None, None
    if mix_weights:
        total_weight = sum(mix_weights.values())
        cumulative, running = [], 0.0
        for kind, weight in mix_weights.items():
            running += weight / total_weight
            cumulative.append((running, kind))
        pool_payload = {}
        for path in pool_paths:
            raw = Path(path).read_bytes()
            checkpoint = json.loads(raw)
            if checkpoint.get('format') != FORMAT or checkpoint.get('engineVersion') != ENGINE:
                parser.error(f'pool checkpoint {path} is incompatible')
            name = hashlib.sha256(raw).hexdigest()[:12]
            weights = {key: dict(shape=list(np.array(value).shape), data=base64.b64encode(np.array(value, dtype='<f4').tobytes()).decode('ascii'))
                       for key, value in checkpoint['weights'].items()}
            pool_payload[name] = dict(meta={key: value for key, value in checkpoint.items() if key != 'weights'}, weightsB64=weights)
            pool_names.append(name)
        pool_key = hashlib.sha256(','.join(sorted(pool_names)).encode()).hexdigest()[:16]
        pool_line = '"poolB64":' + json.dumps(pool_payload, separators=(',', ':'))

    def kind_for(base_seed, index):
        """Opponent kind for one attempt: a pure function of (batch seed, attempt index), so worker count never matters."""
        if not mix_weights:
            return args.training_opponent
        digest = hashlib.sha256(f'{base_seed}:{index}:opponent'.encode()).digest()
        draw = int.from_bytes(digest[:8], 'big') / 2**64
        kind = next(kind for limit, kind in cumulative if draw < limit or limit == cumulative[-1][0])
        return f'pool:{pool_names[int.from_bytes(digest[8:16], "big") % len(pool_names)]}' if kind == 'pool' else kind
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

    def collect_parallel(games):
        """Same contract as the legacy `collect` command, produced by the worker pool under one frozen policy version."""
        nonlocal battles_generated, attempts_total, next_seed, battles_completed, truncated_total
        nonlocal baseline_games, baseline_attempts, baseline_completed, baseline_truncated
        nonlocal policy_version, pending_attempts, pending_self
        completed_self = completed_base = 0
        policy_version += 1
        start = time.perf_counter()
        model_line = ('"model":' + json.dumps(model.export(steps, battles_generated, trained_on, baseline_trained_on, with_weights=False),
                                              separators=(',', ':')) +
                      ',"weightsB64":' + json.dumps(model.weights_b64(), separators=(',', ':')))
        timers['serialize'] += time.perf_counter() - start
        base_seed = next_seed
        completed_here = truncated_here = attempts_here = 0
        retries = traps = illegal = 0
        diagnostics, episodes = [], []
        started = time.perf_counter()
        while completed_here < games:
            # Truncated attempts never count; top up with the following attempt indices, as the legacy loop does.
            wanted = games - completed_here
            indices = list(range(attempts_here, attempts_here + wanted))
            attempts_here += wanted
            kind_of = {i: kind_for(base_seed, i) for i in indices}
            self_here = sum(kind == 'selfplay' for kind in kind_of.values())
            pending_attempts += wanted; pending_self += self_here
            battles_generated += self_here; attempts_total += self_here
            baseline_games += wanted - self_here; baseline_attempts += wanted - self_here
            results = pool.collect(model_line, policy_version, base_seed, indices, args.training_opponent,
                                   args.max_turns, args.concurrency, timers, kind_of, pool_key, pool_line, team_sets or None)
            if [item['index'] for item in results] != indices:
                raise RuntimeError('Worker pool returned an unexpected set of battle indices')
            for item in results:
                is_self = item.get('kind', args.training_opponent) == 'selfplay'
                pending_attempts -= 1; pending_self -= is_self
                retries += item['retries']; traps += item['hiddenTrapReveals']; illegal += item['illegalActionRetries']
                diagnostics.extend(item['rejectionDiagnostics'])
                if item['truncated']:
                    truncated_here += 1
                    if is_self: truncated_total += 1
                    else: baseline_truncated += 1
                else:
                    completed_here += 1
                    if is_self: battles_completed += 1; completed_self += 1
                    else: baseline_completed += 1; completed_base += 1
                    model.opponent_counts[item.get('kind', args.training_opponent)] = model.opponent_counts.get(item.get('kind', args.training_opponent), 0) + 1
                    episodes.extend(item['episodes'])
            if truncated_here >= 3:
                break
        next_seed = base_seed + attempts_here
        timers['collect_wall'] += time.perf_counter() - started
        save('running', checkpoint=False)
        return dict(episodes=episodes, attempts=attempts_here, completed=completed_here, truncated=truncated_here,
                    retries=retries, hiddenTrapReveals=traps, illegalActionRetries=illegal,
                    rejectionDiagnostics=diagnostics, turnsRemaining=games - completed_here,
                    completedSelf=completed_self, completedBase=completed_base)

    def save(status='running', checkpoint=True, deployable=True):
        if checkpoint:
            if deployable:
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
                            ledgerBaseline=ledger_baseline, next_seed=next_seed, rng=torch.get_rng_state(),
                            opponentCounts=dict(model.opponent_counts)), temp_state)
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
                        teamGeneratorVersion=TEAM_GENERATOR,
                        initialization=('random; no demonstration data' if not args.init_from else
                                        'local frozen M-C checkpoint; fresh optimizer'),
                        criticReinitialized=critic_reinitialized, device='CPU; Apple M5 / 16 GB host',
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
                        trainingBattlesPerSecond=round(((battles_generated-started_games+baseline_games-started_baseline_games) if args.training_opponent == 'mix'
                                                        else (battles_generated-started_games) if args.training_opponent == 'selfplay'
                                                        else (baseline_games-started_baseline_games))/elapsed, 3) if elapsed else 0,
                        opponentBattles=dict(model.opponent_counts),
                        targetBattles=args.battles, workers=args.workers if pool else 0, concurrency=args.concurrency,
                        torchThreads=args.torch_threads, policyVersion=policy_version,
                        timersSeconds={k: round(v, 3) for k, v in timers.items()}, recentUpdates=recent[-20:])
        temp_status = output.with_suffix('.status.tmp')
        temp_status.write_text(json.dumps(progress, indent=2))
        temp_status.replace(output.with_suffix('.status.json'))
        combined = dict(ledger)
        combined.update(totals)
        combined.update(randomThroughputBenchmarkBattles=int(ledger.get('randomThroughputBenchmarkBattles', 0)),
                        externalReplayTrainingBattles=0,
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
        combined['totalMCLocalBattlesGenerated'] = sum(int(combined.get(key, 0)) for key in (
            'randomThroughputBenchmarkBattles', 'preflightRandomPolicyBattlesGenerated',
            'selfPlayBattlesGenerated', 'baselineTrainingBattlesGenerated', 'evaluationBattles',
            'ladderBattlesStarted'))
        temp_ledger = ledger_path.with_suffix('.tmp')
        temp_ledger.write_text(json.dumps(combined, indent=2))
        temp_ledger.replace(ledger_path)

    try:
        # Verify the Python learner and deployable Node checkpoint use identical logits/value,
        # including the carried recurrent memory across consecutive decisions.
        parity_steps = 3 if model.recurrent else 1
        state = np.random.uniform(-1, 1, (parity_steps, STATE_DIM)).astype('float32')
        actions = np.random.uniform(-1, 1, (parity_steps, 5, ACTION_DIM)).astype('float32')
        simple_scores = np.random.uniform(0, 5, (parity_steps, 5)).astype('float32')
        with torch.no_grad():
            hidden_seq = model.hidden_sequence(torch.tensor(state)[None])
            distribution, value = model.heads(hidden_seq[0], torch.tensor(actions), torch.ones((parity_steps, 5), dtype=torch.bool),
                                              torch.tensor(simple_scores))
        node_hidden = None
        for t in range(parity_steps):
            encoded = dict(state=state[t].tolist(), actions=actions[t].tolist(), simpleScores=simple_scores[t].tolist())
            encoded['exploration'] = model.exploration
            if node_hidden is not None:
                encoded['hidden'] = node_hidden
            parity = call('predict', encoded=encoded)
            node_hidden = parity.get('hidden')
            np.testing.assert_allclose(parity['mixedProbabilities'], distribution.probs[t].numpy(), atol=2e-5, rtol=2e-5)
            np.testing.assert_allclose(parity['value'], value[t].item(), atol=2e-5, rtol=2e-5)
        if pool:   # the dedicated parity process is idle from here on; free its memory
            worker.stdin.close()
            worker.wait(timeout=10)
        print(json.dumps(dict(event='inference-parity-passed', parameters=sum(p.numel() for p in model.parameters()), torch=torch.__version__)), flush=True)
        save()
        def progress_counters():
            if args.training_opponent == 'mix':
                return (attempts_total + baseline_attempts, battles_completed + baseline_completed, truncated_total + baseline_truncated)
            return ((attempts_total, battles_completed, truncated_total) if args.training_opponent == 'selfplay'
                    else (baseline_attempts, baseline_completed, baseline_truncated))
        def active_completed():
            return progress_counters()[1]
        while not stopping and active_completed() < args.battles:
            before_attempts, before_completed, before_truncated = progress_counters()
            games_wanted = min(args.batch_games, args.battles-active_completed())
            if pool and not args.debug:
                batch = collect_parallel(games_wanted)
            else:
                collect_start = time.perf_counter()
                batch = call('collect', games=games_wanted, seed=next_seed,
                             opponent=args.training_opponent, maxTurns=args.max_turns, debug=args.debug)
                timers['collect_wall'] += time.perf_counter() - collect_start
            after_attempts, after_completed, after_truncated = progress_counters()
            if (batch['attempts'] != after_attempts-before_attempts or
                    batch['completed'] != after_completed-before_completed or
                    batch['truncated'] != after_truncated-before_truncated):
                raise RuntimeError('Simulator progress events do not match training batch totals')
            if args.debug:
                print(json.dumps(dict(event='training-diagnostic', opponent=args.training_opponent, generated=batch['attempts'], completed=batch['completed'],
                                      truncated=batch['truncated'], retries=batch['retries'], turnsRemaining=batch['turnsRemaining'])), flush=True)
            prep_start = time.perf_counter()
            rows, returns, advantages = [], [], []
            rewards = []
            episode_rows = []
            for episode in batch['episodes']:
                rewards.append(episode['reward'])
                ep_returns, ep_advantages = compute_gae(episode, GAMMA, GAE_LAMBDA, args.shaping)
                episode_rows.append(list(range(len(rows), len(rows)+len(episode['steps']))))
                rows.extend(episode['steps'])
                returns.extend(ep_returns)
                advantages.extend(ep_advantages)
            if not rows:
                raise RuntimeError('Self-play batch returned no policy decisions')

            states = torch.tensor([row['state'] for row in rows], dtype=torch.float32)
            for row in rows:
                # One float32 conversion per decision instead of one per minibatch; values are unchanged.
                row['actions'] = np.asarray(row['actions'], dtype=np.float32)
                row['simpleScores'] = np.asarray(row['simpleScores'], dtype=np.float32)
            chosen = torch.tensor([row['action'] for row in rows], dtype=torch.long)
            rollout_logp = torch.tensor([row['logp'] for row in rows], dtype=torch.float32)
            targets = torch.tensor(returns, dtype=torch.float32)
            if args.shaping:
                targets = targets.clamp(-1, 1)   # the critic is tanh-bounded
            adv = torch.tensor(advantages, dtype=torch.float32)
            adv = (adv - adv.mean()) / (adv.std(unbiased=False) + 1e-8)
            # Check the JS rollout probability against the exact same mixed policy in Torch.
            # Then use that Torch value as the frozen old log-probability so the first PPO
            # ratio is exactly one despite JS-double / Torch-float32 rounding differences.
            behavior_logps = []
            with torch.no_grad():
                if model.recurrent:
                    # Unroll each battle side from zero memory; logp order follows the concatenated episode rows.
                    order = torch.tensor([j for group in episode_rows for j in group])
                    dist, _ = model.forward_episodes(*pad_rows(rows, states, episode_rows))
                    batch_behavior_logp = dist.log_prob(chosen[order])
                    torch.testing.assert_close(batch_behavior_logp, rollout_logp[order], atol=1e-4, rtol=1e-4)
                    behavior_logps.append(batch_behavior_logp)
                for start in range(0, 0 if model.recurrent else len(rows), 32):
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
                    batch_behavior_logp = dist.log_prob(chosen[ix])
                    torch.testing.assert_close(batch_behavior_logp, rollout_logp[ix], atol=1e-4, rtol=1e-4)
                    recomputed = training_log_probs(model, states[ix], torch.from_numpy(action_batch),
                                                    torch.from_numpy(mask_batch), torch.from_numpy(score_batch), chosen[ix])
                    torch.testing.assert_close(recomputed, batch_behavior_logp, atol=0, rtol=0)
                    behavior_logps.append(batch_behavior_logp)
            old_logp = torch.cat(behavior_logps).detach()
            with torch.no_grad():
                initial_ratio = ppo_ratio(torch.cat(behavior_logps), old_logp)
                if not torch.equal(initial_ratio, torch.ones_like(initial_ratio)):
                    raise RuntimeError('PPO pre-update ratio is not exactly one')

            losses, policy_losses, value_losses, entropies, imitation_losses = [], [], [], [], []
            timers['prep'] += time.perf_counter() - prep_start
            ppo_start = time.perf_counter()
            for _ in range(4):
                if model.recurrent:
                    # ~32 decisions per minibatch, drawn as whole battle sides so memory is unrolled exactly as in rollout.
                    per_batch = max(1, round(32 / (len(rows) / len(episode_rows))))
                    minibatch_groups = [[episode_rows[e] for e in group.tolist()]
                                        for group in torch.randperm(len(episode_rows)).split(per_batch)]
                    minibatches = minibatch_groups
                else:
                    minibatches = list(torch.randperm(len(rows)).split(32))
                for batch_index, ix in enumerate(minibatches):
                    if model.recurrent:
                        groups = minibatch_groups[batch_index]
                        ix = torch.tensor([j for group in groups for j in group])
                        state_pad, action_pad, mask_pad, score_pad, lengths = pad_rows(rows, states, groups)
                        action_masks = mask_pad[torch.arange(state_pad.shape[1])[None, :] < lengths[:, None]]
                        simple_score_batch = score_pad[torch.arange(state_pad.shape[1])[None, :] < lengths[:, None]]
                        dist, values = model.forward_episodes(state_pad, action_pad, mask_pad, score_pad, lengths)
                    else:
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
                        action_masks = torch.from_numpy(mask_batch)
                        simple_score_batch = torch.from_numpy(score_batch)
                        dist, values = model(states[ix], torch.from_numpy(action_batch), action_masks, simple_score_batch)
                    logp = dist.log_prob(chosen[ix])
                    ratio = ppo_ratio(logp, old_logp[ix])
                    policy_loss = -torch.minimum(ratio*adv[ix], ratio.clamp(.8,1.2)*adv[ix]).mean()
                    value_loss = (values-targets[ix]).square().mean()
                    entropy = dist.entropy().mean()
                    imitation_loss = torch.zeros((), dtype=torch.float32)
                    if args.heuristic_imitation_weight:
                        teacher_actions = simple_score_batch.masked_fill(~action_masks, -1e9).argmax(dim=1)
                        imitation_loss = -dist.log_prob(teacher_actions).mean()
                    loss = policy_loss + VALUE_LOSS_COEF*value_loss - ENTROPY_COEF*entropy + args.heuristic_imitation_weight*imitation_loss
                    if not torch.isfinite(loss):
                        raise RuntimeError('Nonfinite PPO loss')
                    optimizer.zero_grad()
                    loss.backward()
                    nn.utils.clip_grad_norm_(model.parameters(), .5)
                    optimizer.step()
                    losses.append(float(loss.item()))
                    policy_losses.append(float(policy_loss.item()))
                    value_losses.append(float(value_loss.item()))
                    entropies.append(float(entropy.item()))
                    imitation_losses.append(float(imitation_loss.item()))
            timers['ppo'] += time.perf_counter() - ppo_start
            steps += len(rows)
            if args.training_opponent == 'mix':
                trained_on += batch['completedSelf']
                baseline_trained_on += batch['completedBase']
            elif args.training_opponent == 'selfplay':
                trained_on += batch['completed']
            else:
                baseline_trained_on += batch['completed']
            update = dict(event=f'ppo-{args.training_opponent}', selfPlayBattlesGenerated=battles_generated,
                          baselineTrainingBattlesGenerated=baseline_games,
                          selfPlayBattlesCompleted=battles_completed, decisions=steps,
                          selfPlayBattlesUsedForPPO=trained_on,
                          heuristicImitationWeight=args.heuristic_imitation_weight,
                          batchDecisions=len(rows), meanReward=float(np.mean(rewards)),
                          loss=float(np.mean(losses)), policyLoss=float(np.mean(policy_losses)),
                          valueLoss=float(np.mean(value_losses)), policyEntropy=float(np.mean(entropies)),
                          heuristicImitationLoss=float(np.mean(imitation_losses)),
                          attempts=batch['attempts'], truncated=batch['truncated'],
                          retries=batch['retries'], hiddenTrapReveals=batch.get('hiddenTrapReveals', 0),
                          illegalActionRetries=batch.get('illegalActionRetries', 0),
                          rejectionDiagnostics=batch.get('rejectionDiagnostics', []),
                          elapsedSeconds=round(time.monotonic()-start_time,2), workers=args.workers if pool else 0,
                          concurrency=args.concurrency, policyVersion=policy_version)
            recent.append(update)
            print(json.dumps(update), flush=True)
            # The resumable .pt state is written after every update; the deployable JSON on a timer, at stop and at completion.
            deployable = time.monotonic() - last_save >= args.checkpoint_seconds
            save('running', deployable=deployable)
            if deployable:
                last_save = time.monotonic()
        save('stopping' if stopping else 'complete')
        parameter_change = (torch.cat([p.detach().flatten() for p in model.parameters()])-baseline_weights).norm().item()
        report = dict(status='stopped' if stopping else 'complete', format=FORMAT, engineVersion=ENGINE,
                      seed=args.seed, trainingOpponent=args.training_opponent,
                      simpleScoreWeight=args.simple_score_weight,
                      heuristicImitationWeight=args.heuristic_imitation_weight,
                      initialization=('fresh random weights; local simulator only' if not args.init_from else
                                      f'local checkpoint {args.init_from}; fresh optimizer'),
                      criticReinitialized=critic_reinitialized,
                      algorithm='PPO with terminal-only GAE; local self-play and generated baseline battles',
                      selfPlayBattlesGenerated=battles_generated, selfPlayBattlesCompleted=battles_completed,
                      selfPlayBattlesUsedForPPO=trained_on,
                      baselineTrainingBattlesGenerated=baseline_games,
                      baselineTrainingBattlesCompleted=baseline_completed,
                      baselineTrainingBattlesUsedForPPO=baseline_trained_on,
                      selfPlayBattleAttempts=attempts_total, truncatedBattles=truncated_total,
                      decisions=steps, parameterChangeL2=parameter_change,
                      workers=args.workers if pool else 0, concurrency=args.concurrency, torchThreads=args.torch_threads,
                      timersSeconds={k: round(v, 3) for k, v in timers.items()},
                      elapsedSeconds=round(time.monotonic()-start_time,2), updates=recent)
        output.with_suffix('.training.json').write_text(json.dumps(report, indent=2))
        print(json.dumps(dict(event=report['status'], checkpoint=str(output), selfPlayBattlesGenerated=battles_generated,
                              selfPlayBattlesCompleted=battles_completed, selfPlayBattlesUsedForPPO=trained_on,
                              decisions=steps, parameterChangeL2=parameter_change)), flush=True)
    except BaseException:
        if pending_attempts:
            if args.training_opponent == 'mix':
                aborted_total += pending_self; baseline_aborted += pending_attempts - pending_self
            elif args.training_opponent == 'selfplay': aborted_total += pending_attempts
            else: baseline_aborted += pending_attempts
            pending_attempts = pending_self = 0
        if inflight is not None:
            if inflight[1] == 'selfplay': aborted_total += 1
            else: baseline_aborted += 1
            inflight = None
        save('failed')
        raise
    finally:
        if pool:
            pool.close()
        worker.stdin.close()
        try:
            worker.wait(timeout=5)
        except subprocess.TimeoutExpired:
            worker.terminate()
            worker.wait(timeout=5)


if __name__ == '__main__':
    main()
