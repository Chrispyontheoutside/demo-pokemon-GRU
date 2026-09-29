"""End-to-end and per-component throughput benchmark for the M-C trainer.

Runs `train_champions.py` for a fixed battle count per configuration (one after another, so runs never compete for
cores) and reads the trainer's own timers. Every run uses a scratch output directory and its own ledger.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def run(config, battles, scratch, architecture, seed):
    name = '-'.join(f'{k}{v}' for k, v in config.items())
    out = scratch / name
    if out.exists():
        shutil.rmtree(out)
    cmd = [sys.executable, 'agents/train_champions.py', '--architecture', architecture, '--training-opponent', 'heuristic',
           '--battles', str(battles), '--seed', str(seed), '--output', str(out / 'policy.json')]
    if config.get('legacy'):
        cmd.append('--legacy-collect')
    for key, flag in (('workers', '--workers'), ('conc', '--concurrency'), ('threads', '--torch-threads'), ('batch', '--batch-games')):
        if key in config:
            cmd += [flag, str(config[key])]
    subprocess.run(cmd, cwd=ROOT, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    report = json.loads((out / 'policy.training.json').read_text())
    timers = report['timersSeconds']
    elapsed = report['elapsedSeconds']
    completed = report['baselineTrainingBattlesCompleted']
    decisions = report['decisions']
    row = dict(config=config, architecture=architecture, battles=completed, decisions=decisions, elapsedSeconds=elapsed,
               endToEndBattlesPerSecond=round(completed / elapsed, 2), timersSeconds=timers)
    if timers['encodeCalls']:
        # Simulator-side numbers are summed over all workers (CPU-seconds, not wall-seconds).
        row['encodeCallsPerCpuSecond'] = round(timers['encodeCalls'] / (timers['encodeMs'] / 1000), 1)
        row['inferenceDecisionsPerCpuSecond'] = round(timers['chooseCalls'] / (timers['chooseMs'] / 1000), 1)
        row['simulatorOnlyCpuSecondsPerBattle'] = round((timers['worker_wall'] - (timers['encodeMs'] + timers['chooseMs']) / 1000) / completed, 5)
    row['ppoSecondsPerBattle'] = round(timers['ppo'] / completed, 5)
    row['prepSecondsPerBattle'] = round(timers['prep'] / completed, 5)
    row['serializeSecondsPerBattle'] = round(timers['serialize'] / completed, 5)
    row['sendSecondsPerBattle'] = round(timers['send'] / completed, 5)
    print(json.dumps(dict(config=config, bps=row['endToEndBattlesPerSecond'], elapsed=elapsed)), flush=True)
    shutil.rmtree(out)
    return row


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--battles', type=int, default=1600)
    parser.add_argument('--architecture', choices=['feedforward', 'gru'], default='feedforward')
    parser.add_argument('--seed', type=int, default=20261000)
    parser.add_argument('--sweep', choices=['workers', 'threads', 'batch', 'all'], default='workers')
    parser.add_argument('--workers-grid', default='1,2,4,6,8')
    parser.add_argument('--concurrency-grid', default='1,2,4')
    parser.add_argument('--best-workers', type=int, default=4)
    parser.add_argument('--best-concurrency', type=int, default=1)
    parser.add_argument('--output')
    args = parser.parse_args()
    scratch = Path(tempfile.mkdtemp(prefix='champions-bench-'))
    configs = []
    if args.sweep in ('workers', 'all'):
        configs.append(dict(legacy=True))
        for workers in map(int, args.workers_grid.split(',')):
            for conc in map(int, args.concurrency_grid.split(',')):
                configs.append(dict(workers=workers, conc=conc))
    if args.sweep in ('threads', 'all'):
        for threads in (1, 2, 4):
            configs.append(dict(workers=args.best_workers, conc=args.best_concurrency, threads=threads))
    if args.sweep in ('batch', 'all'):
        for batch in (8, 16, 32, 64):
            configs.append(dict(workers=args.best_workers, conc=args.best_concurrency, batch=batch))
    rows = [run(config, args.battles, scratch, args.architecture, args.seed) for config in configs]
    report = dict(generatedAt=datetime.now(timezone.utc).isoformat(), host='Apple M5, 10 cores (4P+6E), 16 GB',
                  battlesPerConfiguration=args.battles, trainingOpponent='heuristic', rows=rows)
    output = Path(args.output) if args.output else ROOT / 'reports/champions-vgc-2026-reg-mc' / (
        f"throughput-benchmark-{args.sweep}-{args.architecture}-{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S')}.json")
    output.write_text(json.dumps(report, indent=2))
    print(f'wrote {output}')
    shutil.rmtree(scratch, ignore_errors=True)


if __name__ == '__main__':
    main()
