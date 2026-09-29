"""Conditional human (opponent) behaviour rates from our own ladder battle logs.

    python3 scripts/human-behaviour.py [--out runs/champions-vgc-2026-reg-mc/human-behaviour.json]

For every opponent active slot on every turn: hp bucket of that Pokemon, turn bucket, and what it did (move / protect / fake out /
voluntary switch). Own battles only. Forced replacements after a faint are not voluntary switches.
"""
import glob, json, re, sys, collections
ME = ('avin-owes-me-25', 'ChampionsMC808583')
PROTECT = {'Protect', 'Detect', "King's Shield", 'Spiky Shield', 'Baneful Bunker', 'Obstruct', 'Silk Trap', 'Burning Bulwark', 'Wide Guard', 'Quick Guard'}
hp_bucket = lambda f: 0 if f < .35 else 1 if f < .7 else 2
turn_bucket = lambda t: 0 if t <= 1 else 1 if t <= 3 else 2
rows = []
focus = collections.defaultdict(lambda: [0, 0])   # band -> [same-target turns, two-attack turns]
band_of = lambda r: 'low' if r < 1061 else 'mid' if r < 1145 else 'high'
seen = set()
for path in sorted(glob.glob('runs/champions-vgc-2026-reg-mc/ladder/*/battle-*.log')):
    room = path.split('/')[-1]
    if room in seen: continue
    seen.add(room)
    lines = open(path).read().split('\n')
    players = {}
    for l in lines:
        p = l.split('|')
        if len(p) > 3 and p[1] == 'player': players[p[2]] = p[3]
    opp = 'p2' if players.get('p1') in ME else 'p1' if players.get('p2') in ME else None
    if opp is None: continue
    rating_of = {q[3]: int(q[5]) for q in (l.split('|') for l in lines[:14]) if len(q) > 5 and q[1] == 'player' and q[5].isdigit()}
    band = band_of(rating_of.get(players.get(opp), 1100))
    turn_targets = {}
    hp = {}; active = {}; turn = 0; acted = set(); fainted_slots = set(); last_protect = {}
    for l in lines:
        p = l.split('|')
        if len(p) < 3: continue
        k = p[1]
        if k == 'turn':
            if len(turn_targets) == 2:
                focus[band][1] += 1; focus[band][0] += len(set(turn_targets.values())) == 1
            turn_targets = {}
            turn = int(p[2]); acted = set(); fainted_slots = set()
        elif k in ('switch', 'drag') and len(p) > 4:
            slot = p[2][:3]; incoming = p[2].split(': ')[-1]; m = re.match(r'(\d+)/(\d+)', p[4])
            outgoing_hp = hp.get(active.get(slot), 1)
            hp[incoming] = int(m[1]) / int(m[2]) if m else 1
            if slot[:2] == opp and turn > 0 and slot not in fainted_slots and k == 'switch' and slot not in acted:
                rows.append((turn, hp_bucket(outgoing_hp), 'switch', band))
                acted.add(slot)
            active[slot] = incoming
        elif k in ('-damage', '-heal') and len(p) > 3:
            m = re.match(r'(\d+)/(\d+)', p[3]); name = p[2].split(': ')[-1]
            if m: hp[name] = int(m[1]) / int(m[2])
        elif k == 'faint': fainted_slots.add(p[2][:3])
        elif k == 'move' and len(p) > 3 and p[2][:2] == opp and 'move:' not in ''.join(p[4:5]):
            slot = p[2][:3]; name = p[2].split(': ')[-1]
            if slot in acted: continue
            acted.add(slot)
            f = hp.get(name, 1)
            kind = 'protect' if p[3] in PROTECT else 'fakeout' if p[3] == 'Fake Out' else 'move'
            rows.append((turn, hp_bucket(f), kind, band))
            if kind == 'move' and len(p) > 4 and p[4][:2] != opp and p[4][:2] in ('p1', 'p2'): turn_targets[slot] = p[4][:3]
# switches recorded before the turn counter increments were forced replacements; keep only rows from turn >= 1 with a live slot
table = collections.defaultdict(collections.Counter)
band_table = collections.defaultdict(lambda: collections.defaultdict(collections.Counter))
for turn, hb, kind, band in rows:
    table[f'{turn_bucket(turn)}:{hb}'][kind] += 1
    band_table[band][f'{turn_bucket(turn)}:{hb}'][kind] += 1
out = {'games': len(seen), 'rows': len(rows), 'table': {}}
for key, c in sorted(table.items()):
    n = sum(c.values()); out['table'][key] = {'n': n, **{k: round(c[k] / n, 3) for k in ('move', 'protect', 'fakeout', 'switch')}}
def rates(c, fallback=None, prior=30):
    n = sum(c.values()); out = {'n': n}
    for k in ('move', 'protect', 'fakeout', 'switch'):
        base = (fallback or {}).get(k, c[k] / max(1, n))
        out[k] = round((c[k] + prior * base) / (n + prior), 3)      # shrink small cells toward the pooled rate
    return out
out['bands'] = {}
for band, cells in band_table.items():
    n_games = sum(sum(c.values()) for c in cells.values())
    out['bands'][band] = {'rows': n_games, 'focusFire': round(focus[band][0] / max(1, focus[band][1]), 3), 'focusTurns': focus[band][1],
                          'table': {key: rates(c, out['table'].get(key)) for key, c in sorted(cells.items())}}
target = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else 'runs/champions-vgc-2026-reg-mc/human-behaviour.json'
json.dump(out, open(target, 'w'), indent=1)
print(json.dumps(out, indent=1))
