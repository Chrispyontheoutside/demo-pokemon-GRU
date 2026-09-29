#!/usr/bin/env python3
"""Watches ladder summaries; the first time a rated win leaves the account at >= THRESHOLD it saves evidence and writes a state report.
Evidence: the server's own battle log (with the official rating-change message), the decision log, the session summary, the exact
policy + team used (read-only copies), an attempted real screenshot (needs macOS Screen Recording permission), and REPORT.md.
Usage: scripts/watch-milestone.py [threshold=1250]   (idempotent: writes a .done marker per threshold)"""
import glob, hashlib, json, os, shutil, stat, subprocess, sys, time
os.chdir(os.path.dirname(os.path.abspath(__file__)) + '/..')
THRESHOLD = int(sys.argv[1]) if len(sys.argv) > 1 else 1250
OUT_ROOT = os.environ.get('WATCH_OUT', 'runs/champions-vgc-2026-reg-mc/milestones-live')
os.makedirs(OUT_ROOT, exist_ok=True)
done_marker = f'{OUT_ROOT}/elo-{THRESHOLD}.done'
sha = lambda path: hashlib.sha256(open(path, 'rb').read()).hexdigest()

def rating_after(summary_path, summary, result):
    """ratingAfter from the summary, else from the server's rating line in the battle log (hyphenated names were once missed)."""
    if result.get('ratingAfter'): return result['ratingAfter']
    import re
    own = re.sub(r'[^a-z0-9]', '', summary['name'].lower()); found = None
    try:
        for line in open(f"{os.path.dirname(summary_path)}/{result['room']}.log").read().split('\n'):
            m = re.match(r"^\|raw\|(.*?)'s rating: \d+ &rarr; <strong>(\d+)</strong>", line)
            if m and re.sub(r'[^a-z0-9]', '', m.group(1).lower()) == own: found = int(m.group(2))
    except Exception: pass
    return found

def find_trigger():
    hit = None
    for summary_path in sorted(glob.glob('runs/champions-vgc-2026-reg-mc/ladder/*/summary.json')):
        try: summary = json.load(open(summary_path))
        except Exception: continue
        for result in summary.get('results', []):
            if result.get('outcome') == 'win' and (rating_after(summary_path, summary, result) or 0) >= THRESHOLD:
                hit = (summary_path, summary, result)
                return hit
    return hit

def all_games():
    rows = []
    for summary_path in sorted(glob.glob('runs/champions-vgc-2026-reg-mc/ladder/*/summary.json')):
        try: summary = json.load(open(summary_path))
        except Exception: continue
        for result in summary.get('results', []):
            if rating_after(summary_path, summary, result):
                result['ratingAfter'] = rating_after(summary_path, summary, result)
                rows.append((summary_path, summary, result))
    return rows

def capture(summary_path, summary, result):
    stamp = time.strftime('%Y%m%dT%H%M%S')
    folder = f'{OUT_ROOT}/elo-{THRESHOLD}-{stamp}'
    os.makedirs(folder, exist_ok=True)
    session = os.path.dirname(summary_path)
    room = result['room']
    for name in (f'{room}.log', f'{room}.decisions.json', 'summary.json'):
        if os.path.exists(f'{session}/{name}'): shutil.copy(f'{session}/{name}', f'{folder}/{name}')
    policy, team = summary['checkpointPath'], summary.get('teamFile')
    for path in (policy, team):
        if path and os.path.exists(path):
            target = f'{folder}/{os.path.basename(os.path.dirname(path)) if path.endswith("policy.json") else "team"}-{os.path.basename(path)}'
            shutil.copy(path, target); os.chmod(target, stat.S_IREAD | stat.S_IRGRP | stat.S_IROTH)
    url = f'https://play.pokemonshowdown.com/{room}'
    screenshot = {'attempted': True, 'url': url}
    if not os.environ.get('WATCH_NO_OPEN'):
        subprocess.run(['open', url], capture_output=True); time.sleep(12)
    shot = f'{folder}/screenshot.png'
    proc = subprocess.run(['screencapture', '-x', shot], capture_output=True, text=True)
    screenshot['ok'] = proc.returncode == 0 and os.path.exists(shot) and os.path.getsize(shot) > 0
    screenshot['message'] = (proc.stderr or proc.stdout).strip() or None
    log = open(f'{folder}/{room}.log').read() if os.path.exists(f'{folder}/{room}.log') else ''
    rating_lines = [line for line in log.split('\n') if 'rating' in line.lower() and '|raw|' in line]
    games = all_games()
    same = [g for g in games if g[1]['checkpointSHA256'] == summary['checkpointSHA256'] and g[1].get('teamSHA256') == summary.get('teamSHA256')]
    wins = sum(1 for g in same if g[2]['outcome'] == 'win')
    recent = [g[2]['ratingAfter'] for g in games[-25:]]
    registry = subprocess.run(['node', 'scripts/champions-registry.mjs', 'ingest-ladder'] + glob.glob('runs/champions-vgc-2026-reg-mc/ladder/*/summary.json'), capture_output=True, text=True).stdout
    report = f"""# Elo {THRESHOLD}+ evidence and state report
Captured {time.strftime('%Y-%m-%d %H:%M:%S %Z')} (automatic, `scripts/watch-milestone.py`).

## The game that crossed {THRESHOLD}
- Room: `{room}`  ({url})
- Result: **win**, {result.get('turns')} turns, opponent `{[v for v in result['players'].values() if v != summary['name']]}`
- Rating after: **{rating_after(summary_path, summary, result)}** (ratings at battle start: {json.dumps(result.get('ratingsAtBattleStart'))})
- Server rating message(s): {json.dumps(rating_lines, ensure_ascii=False)}
- Screenshot: {'`screenshot.png` (ok)' if screenshot['ok'] else 'FAILED - ' + str(screenshot['message']) + ' (grant Screen Recording permission to the terminal app; the battle log above is the server-side evidence)'}

## Playing configuration (frozen copies in this folder, read-only)
- Policy: `{summary['checkpointPath']}`  sha256 `{summary['checkpointSHA256']}`  ({summary.get('modelSteps')} decisions trained)
- Team: `{summary.get('teamFile')}`  sha256 `{summary.get('teamSHA256')}`  species {summary.get('teamSpecies')}
- Inference: temperature {summary.get('temperature', 1)}, GRU memory carried: {summary.get('carriesRecurrentMemory')}

## Credibility (do not mistake a spike for sustained strength)
- Account rating over the last {len(recent)} rated games: {recent}; mean {sum(recent)/max(1, len(recent)):.0f}. Registry rule for a milestone: >= 50 rated games AND final rating >= threshold AND last-25-game mean >= threshold.
- This configuration's ladder record: {wins}-{len(same)-wins} over {len(same)} games.
- Registry output (per checkpoint, genuine record excludes early forfeits/timers):
```
{registry.strip()}
```
See `runs/champions-vgc-2026-reg-mc/STATUS.md` for the full experiment journal and morning report.
"""
    open(f'{folder}/REPORT.md', 'w').write(report)
    open(done_marker, 'w').write(folder)
    print('captured', folder, 'screenshot ok' if screenshot['ok'] else 'screenshot FAILED', flush=True)

if os.path.exists(done_marker): sys.exit(0)
while not os.path.exists(done_marker):
    hit = find_trigger()
    if hit: capture(*hit); break
    time.sleep(20)
