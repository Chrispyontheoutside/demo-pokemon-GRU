"""Audit 50 consecutive rated battles at >=1350 on one account/configuration."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUN = ROOT / 'runs/champions-vgc-2026-reg-mc'
accounts = {}
seen = set()
for path in sorted((RUN / 'ladder').glob('*/summary.json')):
    summary = json.loads(path.read_text())
    if summary.get('format') != 'gen9championsvgc2026regmc':
        continue
    name = summary['name']
    config = [summary.get('checkpointSHA256'), summary.get('teamSHA256'), summary.get('temperature')]
    for game in summary['results']:
        room = game['room']
        key = (name, room)
        if key in seen or game.get('outcome') not in ('win', 'loss', 'tie'):
            continue
        seen.add(key)
        rating = game.get('ratingAfter')
        messages = [m for m in game.get('ratingMessages', []) if m.startswith(f"|raw|{name}'s rating:")]
        log = path.parent / f'{room}.log'
        verified = (isinstance(rating, (int, float)) and len(messages) == 1 and log.exists()
                    and messages[0] in log.read_text() and f'<strong>{rating}</strong>' in messages[0])
        accounts.setdefault(name, []).append({'room': room, 'rating': rating, 'config': config,
                                              'verified': verified, 'summary': str(path)})

report = {'objective': '1350 Elo sustained over 50 battles',
          'criterion': '50 consecutive rated battles on the same account, checkpoint, team and temperature; every post-battle rating >=1350; server rating messages verified against saved battle logs',
          'achieved': False, 'accounts': {}}
for name, games in accounts.items():
    streak = []
    best = []
    windows = []
    for game in games:
        qualifies = game['verified'] and game['rating'] >= 1350 and all(game['config'][:2])
        if not qualifies:
            streak = []
            continue
        if streak and streak[-1]['config'] != game['config']:
            streak = []
        streak.append(game)
        if len(streak) > len(best):
            best = list(streak)
        if len(streak) == 50:
            windows.append(list(streak))
    report['accounts'][name] = {'ratedBattles': len(games), 'latestRating': games[-1]['rating'],
                                'longestQualifyingStreak': len(best), 'currentQualifyingStreak': len(streak),
                                'currentConfiguration': streak[-1]['config'] if streak else None,
                                'qualifyingWindows': windows}
    report['achieved'] |= bool(windows)
destination = RUN / 'goal-1350-audit.json'
destination.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'achieved': report['achieved'], 'accounts': {
    name: {k: v for k, v in row.items() if k != 'qualifyingWindows'} for name, row in report['accounts'].items()}}))
