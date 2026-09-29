"""Deterministic checks for the M-C value and PPO behavior-policy paths."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import numpy as np
import torch
from torch.distributions import Categorical

from train_champions import Model, compute_gae, pad_rows, ppo_ratio, training_log_probs


ROOT = Path(__file__).resolve().parents[1]


class ChampionsPPOTests(unittest.TestCase):
    def test_terminal_reward_is_only_applied_on_final_decision(self):
        episode = {'reward': 1.0, 'steps': [{'value': .2}, {'value': -.1}]}
        returns, advantages = compute_gae(episode, gamma=.9, gae_lambda=1.0)
        torch.testing.assert_close(torch.tensor(returns), torch.tensor([.9, 1.0]))
        torch.testing.assert_close(torch.tensor(advantages), torch.tensor([.7, 1.1]))

    def test_terminal_state_does_not_bootstrap(self):
        returns, _ = compute_gae({'reward': -1.0, 'steps': [{'value': .6}]})
        self.assertAlmostEqual(returns[0], -1.0, places=6)

    def test_bounded_critic_and_gae_returns(self):
        torch.manual_seed(31)
        model = Model()
        states = torch.linspace(-1, 1, 8 * 800).reshape(8, 800)
        actions = torch.zeros((8, 1, 56))
        mask = torch.ones((8, 1), dtype=torch.bool)
        _, values = model(states, actions, mask)
        self.assertTrue(bool(torch.all(values >= -1)))
        self.assertTrue(bool(torch.all(values <= 1)))
        for reward in (-1.0, 1.0):
            episode = {'reward': reward, 'steps': [{'value': float(v.detach())} for v in values[:6]]}
            returns, _ = compute_gae(episode)
            self.assertTrue(all(-1.000001 <= value <= 1.000001 for value in returns))

    def test_prior_behavior_log_probability_matches_ppo_path_and_ratio_one(self):
        torch.manual_seed(7)
        model = Model(simple_score_weight=2.75)
        states = torch.linspace(-.8, .9, 3 * 800).reshape(3, 800)
        actions = torch.linspace(-1, 1, 3 * 4 * 56).reshape(3, 4, 56)
        scores = torch.tensor([[0.0, 1.0, 2.0, .5], [1.0, 0.0, .25, 1.5], [.2, .4, .6, .8]])
        mask = torch.ones((3, 4), dtype=torch.bool)
        with torch.no_grad():
            behavior, _ = model(states, actions, mask, scores)
            torch.manual_seed(19)
            sampled_action = behavior.sample()
            recorded_logp = behavior.log_prob(sampled_action)
            recomputed_logp = training_log_probs(model, states, actions, mask, scores, sampled_action)
            self.assertTrue(torch.equal(recorded_logp, recomputed_logp))
            ratio = ppo_ratio(recomputed_logp, recorded_logp)
            self.assertTrue(torch.equal(ratio, torch.ones_like(ratio)))
            network_only_logp = Categorical(logits=behavior.logits - model.simple_score_weight * scores).log_prob(sampled_action)
            self.assertFalse(torch.allclose(recorded_logp, network_only_logp))

    def test_node_and_python_inference_match_with_nonzero_prior(self):
        torch.manual_seed(101)
        model = Model(simple_score_weight=1.75)
        state = np.linspace(-1, 1, 800, dtype=np.float32)
        actions = np.linspace(-.7, .8, 5 * 56, dtype=np.float32).reshape(5, 56)
        scores = np.array([0, 1, 2, .5, 1.25], dtype=np.float32)
        with torch.no_grad():
            distribution, value = model(torch.from_numpy(state)[None], torch.from_numpy(actions)[None],
                                        torch.ones((1, 5), dtype=torch.bool), torch.from_numpy(scores)[None])
        request = {'command': 'predict', 'model': model.export(0, 0, 0),
                   'encoded': {'state': state.tolist(), 'actions': actions.tolist(), 'simpleScores': scores.tolist()}}
        result = subprocess.run(['node', 'dist/src/champions-worker.js'], cwd=ROOT, input=json.dumps(request) + '\n',
                                text=True, capture_output=True, check=True, timeout=30)
        node_prediction = json.loads(result.stdout.strip())
        np.testing.assert_allclose(node_prediction['probabilities'], distribution.probs[0].numpy(), atol=2e-5, rtol=2e-5)
        self.assertAlmostEqual(node_prediction['value'], value.item(), delta=2e-5)
        self.assertGreaterEqual(node_prediction['value'], -1.0)
        self.assertLessEqual(node_prediction['value'], 1.0)

    def test_feedforward_parameters_unchanged_by_recurrent_option(self):
        torch.manual_seed(5)
        control = Model()
        torch.manual_seed(5)
        recurrent = Model(recurrent=True)
        for name, tensor in control.state_dict().items():
            self.assertTrue(torch.equal(tensor, recurrent.state_dict()[name]), name)
        self.assertEqual(sum(p.numel() for p in control.parameters()), 55042)
        self.assertEqual(sum(p.numel() for p in recurrent.parameters()), 55042 + 3 * (2 * 64 * 64 + 2 * 64))

    def test_recurrent_memory_is_causal_and_padding_is_ignored(self):
        torch.manual_seed(11)
        model = Model(recurrent=True)
        generator = np.random.RandomState(3)
        rows = [{'actions': generator.uniform(-1, 1, (3, 56)).tolist(), 'simpleScores': [0.0] * 3} for _ in range(5)]
        states = torch.randn(5, 800)
        dist_a, values_a = model.forward_episodes(*pad_rows(rows, states, [[0, 1, 2], [3, 4]]))
        dist_b, values_b = model.forward_episodes(*pad_rows(rows, states, [[0, 1, 2]]))
        torch.testing.assert_close(dist_a.logits[:3], dist_b.logits, atol=1e-6, rtol=1e-6)
        # Changing a later state cannot change an earlier decision; changing an earlier state must change a later one.
        changed = states.clone()
        changed[2] += 1
        dist_c, _ = model.forward_episodes(*pad_rows(rows, changed, [[0, 1, 2]]))
        torch.testing.assert_close(dist_c.logits[:2], dist_b.logits[:2], atol=1e-6, rtol=1e-6)
        changed = states.clone()
        changed[0] += 1
        dist_d, _ = model.forward_episodes(*pad_rows(rows, changed, [[0, 1, 2]]))
        self.assertFalse(torch.allclose(dist_d.logits[2], dist_b.logits[2]))

    def test_node_and_python_recurrent_inference_match_across_decisions(self):
        torch.manual_seed(13)
        model = Model(recurrent=True)
        states = np.random.RandomState(1).uniform(-1, 1, (4, 800)).astype(np.float32)
        actions = np.random.RandomState(2).uniform(-.8, .8, (4, 5, 56)).astype(np.float32)
        with torch.no_grad():
            hidden = model.hidden_sequence(torch.from_numpy(states)[None])[0]
            distribution, values = model.heads(hidden, torch.from_numpy(actions), torch.ones((4, 5), dtype=torch.bool))
        node_hidden = None
        for t in range(4):
            encoded = {'state': states[t].tolist(), 'actions': actions[t].tolist()}
            if node_hidden is not None:
                encoded['hidden'] = node_hidden
            request = {'command': 'predict', 'model': model.export(0, 0, 0), 'encoded': encoded}
            result = subprocess.run(['node', 'dist/src/champions-worker.js'], cwd=ROOT, input=json.dumps(request) + '\n',
                                    text=True, capture_output=True, check=True, timeout=30)
            prediction = json.loads(result.stdout.strip())
            node_hidden = prediction['hidden']
            np.testing.assert_allclose(prediction['probabilities'], distribution.probs[t].numpy(), atol=2e-5, rtol=2e-5)
            self.assertAlmostEqual(prediction['value'], values[t].item(), delta=2e-5)


    def test_parallel_workers_reproduce_the_sequential_trainer_exactly(self):
        """Same seed => identical weights for the legacy streaming path and multi-worker/concurrent collection."""
        def train(directory, *flags):
            output = Path(directory) / 'policy.json'
            subprocess.run([sys.executable, 'agents/train_champions.py', '--architecture', 'gru', '--training-opponent', 'heuristic',
                            '--battles', '24', '--seed', '20260935', '--output', str(output), *flags],
                           cwd=ROOT, check=True, capture_output=True, timeout=180)
            return json.loads(output.read_text())['weights']
        with tempfile.TemporaryDirectory() as legacy, tempfile.TemporaryDirectory() as pooled, tempfile.TemporaryDirectory() as busy:
            reference = train(legacy, '--legacy-collect')
            self.assertEqual(reference, train(pooled, '--workers', '3'))
            self.assertEqual(reference, train(busy, '--workers', '2', '--concurrency', '3', '--torch-threads', '2'))
            # Every experiment owns its ledger; nothing is written to the shared historical ledger.
            self.assertTrue((Path(pooled) / 'policy.ledger.json').exists())


    def test_mixed_opponents_with_historical_pool_are_worker_count_invariant(self):
        with tempfile.TemporaryDirectory() as scratch:
            torch.manual_seed(77)
            pool_checkpoint = Path(scratch) / 'historical.json'
            pool_checkpoint.write_text(json.dumps(Model(recurrent=True).export(0, 0, 0)))
            def train(name, workers):
                output = Path(scratch) / name / 'policy.json'
                subprocess.run([sys.executable, 'agents/train_champions.py', '--architecture', 'feedforward', '--training-opponent', 'mix',
                                '--opponent-mix', 'heuristic=0.3,selfplay=0.3,pool=0.4', '--pool', str(pool_checkpoint), '--battles', '40',
                                '--seed', '20260935', '--workers', str(workers), '--output', str(output)],
                               cwd=ROOT, check=True, capture_output=True, timeout=240)
                return json.loads(output.read_text())
            one, three = train('one', 1), train('three', 3)
            self.assertEqual(one['weights'], three['weights'])
            counts = one['trainingOpponentBattles']
            self.assertEqual(sum(counts.values()), 40)
            self.assertTrue(any(kind.startswith('pool:') for kind in counts), counts)
            self.assertEqual(counts, three['trainingOpponentBattles'])
            self.assertEqual(one['selfPlayBattlesUsedForPPO'] + one['baselineTrainingBattlesUsedForPPO'], 40)


    def test_wide_and_deep_architectures_match_between_python_and_node(self):
        for recurrent in (False, True):
            torch.manual_seed(211)
            model = Model(recurrent=recurrent, hidden=96, depth=2)
            self.assertEqual(model.export(0, 0, 0)['modelArchitecture'], 'candidate-conditioned-gru-v2' if recurrent else 'candidate-conditioned-v4')
            states = np.random.RandomState(4).uniform(-1, 1, (3, 800)).astype(np.float32)
            actions = np.random.RandomState(5).uniform(-.8, .8, (3, 5, 56)).astype(np.float32)
            with torch.no_grad():
                hidden = model.hidden_sequence(torch.from_numpy(states)[None])[0]
                distribution, values = model.heads(hidden, torch.from_numpy(actions), torch.ones((3, 5), dtype=torch.bool))
            node_hidden = None
            for t in range(3):
                encoded = {'state': states[t].tolist(), 'actions': actions[t].tolist()}
                if node_hidden is not None:
                    encoded['hidden'] = node_hidden
                request = {'command': 'predict', 'model': model.export(0, 0, 0), 'encoded': encoded}
                result = subprocess.run(['node', 'dist/src/champions-worker.js'], cwd=ROOT, input=json.dumps(request) + '\n',
                                        text=True, capture_output=True, check=True, timeout=30)
                prediction = json.loads(result.stdout.strip())
                node_hidden = prediction.get('hidden')
                np.testing.assert_allclose(prediction['probabilities'], distribution.probs[t].numpy(), atol=2e-5, rtol=2e-5)
                self.assertAlmostEqual(prediction['value'], values[t].item(), delta=2e-5)


    def test_entity_transformer_matches_between_python_and_node(self):
        for recurrent in (False, True):
            torch.manual_seed(313)
            model = Model(recurrent=recurrent, hidden=64, trunk='transformer', tf_layers=2)
            self.assertEqual(model.export(0, 0, 0)['modelArchitecture'], 'candidate-conditioned-gru-v3-transformer' if recurrent else 'candidate-conditioned-v5-transformer')
            states = np.random.RandomState(8).uniform(-1, 1, (3, 800)).astype(np.float32)
            actions = np.random.RandomState(9).uniform(-.8, .8, (3, 5, 56)).astype(np.float32)
            with torch.no_grad():
                hidden = model.hidden_sequence(torch.from_numpy(states)[None])[0]
                distribution, values = model.heads(hidden, torch.from_numpy(actions), torch.ones((3, 5), dtype=torch.bool))
            node_hidden = None
            for t in range(3):
                encoded = {'state': states[t].tolist(), 'actions': actions[t].tolist()}
                if node_hidden is not None:
                    encoded['hidden'] = node_hidden
                request = {'command': 'predict', 'model': model.export(0, 0, 0), 'encoded': encoded}
                result = subprocess.run(['node', 'dist/src/champions-worker.js'], cwd=ROOT, input=json.dumps(request) + '\n',
                                        text=True, capture_output=True, check=True, timeout=30)
                prediction = json.loads(result.stdout.strip())
                node_hidden = prediction.get('hidden')
                np.testing.assert_allclose(prediction['probabilities'], distribution.probs[t].numpy(), atol=3e-5, rtol=3e-5)
                self.assertAlmostEqual(prediction['value'], values[t].item(), delta=3e-5)


    def test_potential_shaping_telescopes_and_is_off_by_default(self):
        episode = {'reward': 1.0, 'steps': [{'value': 0., 'potential': .4}, {'value': 0., 'potential': .1}, {'value': 0., 'potential': -.2}]}
        plain, _ = compute_gae(episode, gamma=1., gae_lambda=1.)
        torch.testing.assert_close(torch.tensor(plain), torch.tensor([1., 1., 1.]))
        shaped, _ = compute_gae(episode, gamma=1., gae_lambda=1., shaping=2.0)
        # With gamma=1 the shaped return from step t is the terminal reward minus shaping*phi(s_t): the shaping telescopes.
        torch.testing.assert_close(torch.tensor(shaped), torch.tensor([1. - 2. * .4, 1. - 2. * .1, 1. + 2. * .2]))


    def test_switch_exploration_mixture_matches_between_python_and_node(self):
        torch.manual_seed(415)
        model = Model()
        model.exploration = .2
        state = np.random.RandomState(6).uniform(-1, 1, 800).astype(np.float32)
        actions = np.random.RandomState(7).uniform(-.5, .5, (6, 56)).astype(np.float32)
        actions[:, 1] = actions[:, 25] = 0
        actions[1, 1] = 1     # candidates 1 and 4 contain a voluntary switch
        actions[4, 25] = 1
        with torch.no_grad():
            distribution, _ = model(torch.from_numpy(state)[None], torch.from_numpy(actions)[None], torch.ones((1, 6), dtype=torch.bool))
        request = {'command': 'predict', 'model': model.export(0, 0, 0), 'encoded': {'state': state.tolist(), 'actions': actions.tolist(), 'exploration': .2}}
        result = subprocess.run(['node', 'dist/src/champions-worker.js'], cwd=ROOT, input=json.dumps(request) + '\n', text=True, capture_output=True, check=True, timeout=30)
        node = json.loads(result.stdout.strip())
        np.testing.assert_allclose(node['mixedProbabilities'], distribution.probs[0].numpy(), atol=2e-5, rtol=2e-5)
        raw = np.array(node['probabilities'])
        self.assertAlmostEqual(sum(node['mixedProbabilities']), 1.0, places=6)
        # The two switch candidates each gain exactly eps/2 of extra mass relative to (1-eps) of their raw probability.
        self.assertAlmostEqual(node['mixedProbabilities'][1], .8 * raw[1] + .1, places=5)
        self.assertAlmostEqual(node['mixedProbabilities'][0], .8 * raw[0], places=5)


if __name__ == '__main__':
    unittest.main()
