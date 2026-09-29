"""Expert-iteration fine-tuning: move a policy toward rollout-search action targets.

    python agents/finetune_search.py --init policy.json --labels labels.jsonl --output student.json [--epochs 3] [--lr 1e-4] [--anchor 0.2]

Each labels line is one recorded game of the learner: every decision it made (team preview and forced replacements included,
with no target) so a recurrent student is unrolled over the same decision sequence as in play. Searched decisions carry a target
distribution over a candidate subset; the loss is cross-entropy to that target plus a small KL anchor to the starting policy.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path

import numpy as np
import torch

from train_champions import ACTION_DIM, STATE_DIM, Model


def load_model(path):
    parent = json.loads(Path(path).read_text())
    arch = parent.get('modelArchitecture', '')
    model = Model(recurrent='gru' in arch, hidden=parent.get('hiddenSize', 64), depth=parent.get('depth', 1),
                  trunk=parent.get('trunk', 'mlp'), tf_layers=parent.get('transformerLayers', 2))
    model.load_state_dict({name: torch.tensor(value, dtype=torch.float32) for name, value in parent['weights'].items()}, strict=True)
    return model, parent


def load_episodes(path):
    episodes = []
    for line in Path(path).read_text().splitlines():
        game = json.loads(line)
        if any(step['subset'] for step in game['steps']):
            for step in game['steps']:      # compact float32 arrays keep a 100+ MB label file within memory
                step['state'] = np.asarray(step['state'], dtype=np.float32)
                step['actions'] = np.asarray(step['actions'], dtype=np.float32)
                step['simple'] = np.asarray(step['simple'], dtype=np.float32)
            episodes.append(game['steps'])
    return episodes


def batch_tensors(episodes):
    lengths = torch.tensor([len(steps) for steps in episodes])
    time_steps = int(lengths.max())
    width = max(len(step['actions']) for steps in episodes for step in steps)
    states = torch.zeros((len(episodes), time_steps, STATE_DIM))
    actions = torch.zeros((len(episodes), time_steps, width, ACTION_DIM))
    simple = torch.zeros((len(episodes), time_steps, width))
    mask = torch.zeros((len(episodes), time_steps, width), dtype=torch.bool)
    target = torch.full((len(episodes), time_steps, width), float('-inf'))   # search Q values; -inf = not searched
    has_target = torch.zeros((len(episodes), time_steps), dtype=torch.bool)
    for b, steps in enumerate(episodes):
        for t, step in enumerate(steps):
            n = len(step['actions'])
            states[b, t] = torch.from_numpy(step['state'])
            actions[b, t, :n] = torch.from_numpy(step['actions'])
            simple[b, t, :n] = torch.from_numpy(step['simple'])
            mask[b, t, :n] = True
            if step['subset']:
                has_target[b, t] = True
                for index, value in zip(step['subset'], step['q']):
                    target[b, t, index] = value
    return states, actions, mask, simple, target, has_target, lengths


def losses(model, reference, batch, tau):
    states, actions, mask, simple, q, has_target, lengths = batch
    dist, _ = model.forward_episodes(states, actions, mask, simple, lengths)
    valid = torch.arange(states.shape[1])[None, :] < lengths[:, None]
    flat_q, flat_has = q[valid], has_target[valid]
    log_probs = torch.log_softmax(dist.logits, dim=-1)
    with torch.no_grad():
        old_dist, _ = reference.forward_episodes(states, actions, mask, simple, lengths)
        old_log = torch.log_softmax(old_dist.logits, dim=-1)
        # Policy-improvement target: the starting policy's probabilities re-weighted by exp((Q - Qmax)/tau) on the searched subset
        # (the same operator that made the search-played policy stronger in the paired evaluation).
        searched = torch.isfinite(flat_q)
        top = torch.where(searched, flat_q, torch.full_like(flat_q, float('-inf'))).max(-1, keepdim=True).values
        log_weight = torch.where(searched, torch.log(old_log.exp() + 0.01) + (flat_q - top) / tau, torch.full_like(flat_q, float('-inf')))
        flat_target = torch.softmax(log_weight, dim=-1)
        flat_target = torch.nan_to_num(flat_target, nan=0.0)
    cross_entropy = -(flat_target * log_probs).sum(-1)[flat_has].mean()
    kl = (old_log.exp() * (old_log - log_probs)).sum(-1)[flat_has].mean()
    agreement = (log_probs.argmax(-1) == flat_target.argmax(-1))[flat_has].float().mean()
    return cross_entropy, kl, agreement


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--init', required=True)
    parser.add_argument('--labels', required=True, nargs='+')
    parser.add_argument('--output', required=True)
    parser.add_argument('--epochs', type=int, default=3)
    parser.add_argument('--lr', type=float, default=1e-4)
    parser.add_argument('--anchor', type=float, default=0.2)
    parser.add_argument('--tau', type=float, default=0.2)
    parser.add_argument('--batch-episodes', type=int, default=16)
    parser.add_argument('--seed', type=int, default=20261901)
    args = parser.parse_args()
    torch.set_num_threads(2)
    torch.manual_seed(args.seed)
    rng = np.random.RandomState(args.seed)
    model, parent = load_model(args.init)
    reference = copy.deepcopy(model)
    for parameter in reference.parameters():
        parameter.requires_grad_(False)
    episodes = [episode for path in args.labels for episode in load_episodes(path)]
    order = rng.permutation(len(episodes))
    hold = max(8, len(episodes) // 10)
    held_out = [episodes[i] for i in order[:hold]]
    train = [episodes[i] for i in order[hold:]]
    decisions = sum(1 for steps in train for step in steps if step['subset'])
    print(json.dumps(dict(event='data', episodes=len(train), heldOutEpisodes=len(held_out), searchedDecisions=decisions)), flush=True)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)

    def evaluate():
        model.eval()
        with torch.no_grad():
            values = [tuple(float(x) for x in losses(model, reference, batch_tensors(held_out[i:i + 32]), args.tau)) for i in range(0, len(held_out), 32)]
        model.train()
        return [float(np.mean([v[k] for v in values])) for k in range(3)]

    before = evaluate()
    print(json.dumps(dict(event='held-out-before', crossEntropy=before[0], kl=before[1], argmaxAgreement=before[2])), flush=True)
    for epoch in range(args.epochs):
        permutation = rng.permutation(len(train))
        running = []
        for start in range(0, len(train), args.batch_episodes):
            batch = batch_tensors([train[i] for i in permutation[start:start + args.batch_episodes]])
            cross_entropy, kl, agreement = losses(model, reference, batch, args.tau)
            loss = cross_entropy + args.anchor * kl
            if not torch.isfinite(loss):
                raise RuntimeError('Nonfinite fine-tuning loss')
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), .5)
            optimizer.step()
            running.append((float(cross_entropy), float(kl), float(agreement)))
        held = evaluate()
        print(json.dumps(dict(event='epoch', epoch=epoch + 1, trainCrossEntropy=float(np.mean([r[0] for r in running])),
                              heldOutCrossEntropy=held[0], heldOutKL=held[1], heldOutArgmaxAgreement=held[2])), flush=True)
    student = dict(parent)
    student['weights'] = {name: value.detach().cpu().tolist() for name, value in model.state_dict().items()}
    student['initialization'] = f'expert-iteration fine-tune of {args.init} on {sum(len(s) for s in train)} recorded steps ({decisions} searched)'
    student['expertIteration'] = dict(parent=args.init, parentSHA256=hashlib.sha256(Path(args.init).read_bytes()).hexdigest(),
                                      labels=args.labels, epochs=args.epochs, lr=args.lr, anchor=args.anchor,
                                      heldOutBefore=before, heldOutAfter=held)
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(args.output).with_suffix('.tmp')
    temporary.write_text(json.dumps(student, separators=(',', ':')))
    temporary.replace(args.output)
    print(json.dumps(dict(event='saved', output=args.output, sha256=hashlib.sha256(Path(args.output).read_bytes()).hexdigest())), flush=True)


if __name__ == '__main__':
    main()
