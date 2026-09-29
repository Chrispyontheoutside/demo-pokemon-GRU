#!/usr/bin/env python3
"""Extract opposing teams from OUR OWN ladder battle logs (only battles we fought): per game, the six species shown at preview and, per
species, the moves / item / ability that were revealed during play. Output: human-teams/raw.json (a list of observed teams)."""
import glob, json, os, re, collections
os.chdir(os.path.dirname(os.path.abspath(__file__)) + '/..')
ROOT = 'runs/champions-vgc-2026-reg-mc/ladder'
teams = []
for summary_path in sorted(glob.glob(f'{ROOT}/*/summary.json')):
    summary = json.load(open(summary_path)); folder = os.path.dirname(summary_path); me = summary['name']
    for result in summary['results']:
        if result.get('outcome') not in ('win', 'loss'): continue
        mine = [k for k, v in result['players'].items() if v == me]
        log_path = f"{folder}/{result['room']}.log"
        if not mine or not os.path.exists(log_path): continue
        foe = 'p1' if mine[0] == 'p2' else 'p2'
        lines = open(log_path).read().split('\n')
        species = [re.sub(r',.*', '', line.split('|')[3]) for line in lines if line.startswith(f'|poke|{foe}|')]
        if len(species) < 6: continue
        nick = {}                                    # "p2a: Nick" -> species
        info = collections.defaultdict(lambda: {'moves': [], 'item': None, 'ability': None, 'mega': None})
        for line in lines:
            p = line.split('|')
            if len(p) < 4 or not p[2].startswith(foe): continue
            if p[1] in ('switch', 'drag'):
                nick[p[2].split(': ')[-1]] = re.sub(r',.*', '', p[3])
            slot_name = p[2].split(': ')[-1]
            sp = nick.get(slot_name)
            if not sp: continue
            if p[1] == 'move' and len(p) > 3 and p[3] not in info[sp]['moves']: info[sp]['moves'].append(p[3])
            if p[1] == '-item' and len(p) > 3: info[sp]['item'] = p[3]
            if p[1] == '-enditem' and len(p) > 3: info[sp]['item'] = info[sp]['item'] or p[3]
            if p[1] == '-ability' and len(p) > 3: info[sp]['ability'] = p[3]
            if p[1] == '-mega' and len(p) > 4: info[sp]['mega'] = p[4]; info[sp]['item'] = p[4]
        teams.append({'room': result['room'], 'outcome': result['outcome'], 'species': species,
                      'revealed': {sp: dict(info[sp]) for sp in species if sp in info}})
json.dump(teams, open('runs/champions-vgc-2026-reg-mc/human-teams/raw.json', 'w'), indent=1)
unique = {tuple(sorted(t['species'])) for t in teams}
seen = collections.Counter(sp for t in teams for sp in t['species'])
revealed_moves = sum(len(v['moves']) for t in teams for v in t['revealed'].values())
print(f"{len(teams)} opposing teams from our games ({len(unique)} distinct species sets); {revealed_moves} revealed moves total; "
      f"mean revealed moves per team {revealed_moves/len(teams):.1f}; {sum(1 for t in teams for v in t['revealed'].values() if v['item'])} items revealed")
print('most common:', seen.most_common(10))
