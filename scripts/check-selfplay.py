"""Exercise graceful stop/resume and exact game accounting using temporary local output."""
import hashlib
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

import torch

original = Path('models/gen6-policy.pt')
original_hash = hashlib.sha256(original.read_bytes()).hexdigest()
with tempfile.TemporaryDirectory(prefix='selfplay-check-') as directory:
    output = Path(directory) / 'model.json'
    status_file = output.with_suffix('.status.json')
    command = [sys.executable, 'agents/train_gen6.py', '--eval-pairs', '0', '--output', str(output)]
    with (Path(directory) / 'training.log').open('w+') as log:
        process = subprocess.Popen(command + ['--resume', str(original), '--self-play-games', '5000'], stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    log.seek(0)
                    raise AssertionError(log.read())
                if status_file.exists() and json.loads(status_file.read_text())['selfPlayGames'] > 50:
                    break
                time.sleep(0.1)
            else:
                raise AssertionError('No training progress in 60 seconds')
            # A second writer must fail without touching the active checkpoint.
            duplicate = subprocess.run(command + ['--resume', str(original), '--self-play-games', '5000'], capture_output=True, text=True)
            assert duplicate.returncode != 0 and 'another trainer' in duplicate.stderr
            process.send_signal(signal.SIGTERM)
            assert process.wait(timeout=30) == 0
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=30)
        saved = torch.load(output.with_suffix('.pt'), weights_only=True)
        stopped = json.loads(status_file.read_text())
        assert stopped['status'] == 'stopped'
        assert stopped['checkpointSelfPlayGames'] == saved['selfplay_games'] > 50
        target = saved['selfplay_games'] + 3
        subprocess.run(command + ['--resume', str(output.with_suffix('.pt')), '--self-play-games', str(target)], stdout=log, stderr=log, check=True, timeout=30)
        resumed = torch.load(output.with_suffix('.pt'), weights_only=True)
        result = json.loads(status_file.read_text())
        assert result['status'] == 'complete'
        assert resumed['selfplay_games'] == result['selfPlayGames'] == target
        assert resumed['completed_games'] - saved['completed_games'] == 3
        assert resumed['next_seed'] - saved['next_seed'] == resumed['games'] - saved['games']
        assert any(not torch.equal(saved['model'][key], value) for key, value in resumed['model'].items())
        assert hashlib.sha256(original.read_bytes()).hexdigest() == original_hash
        print(json.dumps(dict(result='passed', stoppedAt=saved['selfplay_games'], resumedExactlyTo=target, originalPreserved=True)))
