import json
import sys
import math
from collections import defaultdict
from pathlib import Path

root = Path(sys.argv[1]).resolve()
run = json.loads((root / 'run.json').read_text())
if run['manifest']['pilot'] or len(run['results']) != 5 * run['manifest']['repetitions']:
    raise SystemExit('Summary requires a complete non-pilot baseline run.')
groups = defaultdict(list)
for result in run['results']:
    groups[result['fixture']['name']].append(result)

def stats(values):
    ordered = sorted(values)
    return {'count': len(values),
            'p50': ordered[max(0, math.ceil(len(ordered) * .5) - 1)],
            'p95': ordered[max(0, math.ceil(len(ordered) * .95) - 1)] if len(ordered) >= 100 else None,
            'max': max(values), 'min': min(values)}

summary = []
for name, results in groups.items():
    item = {'name': name, 'repetitions': len(results), 'fixture': results[0]['counts'],
            'details': stats([v for r in results for v in r['details']]),
            'detailQueryCounts': sorted(set(r['detailsQueryCount'] / len(r['details']) for r in results)),
            'idle': {}, 'backgroundWindow': {}, 'notifications': {}, 'schedulers': {},
            'missedIdleSlots': sum(r['idle']['missed'] for r in results),
            'missedBackgroundSlots': sum(r['concurrent']['missed'] for r in results)}
    for probe in results[0]['idle']['byName']:
        for source, target in [('idle', 'idle'), ('concurrent', 'backgroundWindow')]:
            samples = [p for r in results for p in r[source]['probes'] if p['name'] == probe]
            item[target][probe] = {**stats([p['end'] - p['start'] for p in samples]),
                                  'errors': sum(p['outcome'] != 'ok' for p in samples)}
        overlap = [r['concurrent']['byName'][probe]['overlapping'] for r in results]
        item['backgroundWindow'][probe]['overlapCount'] = sum(v['count'] for v in overlap)
        item['backgroundWindow'][probe]['overlapMax'] = max((v['max'] for v in overlap if v['max'] is not None), default=None)
    for kind in ['first', 'unchanged', 'incremental-100']:
        item['notifications'][kind] = stats([p['elapsedMs'] for r in results for p in r['notificationPasses'] if p['kind'] == kind])
    for venue in ['robinhood', 'coinbase']:
        passes = [p for r in results for p in r['schedulerPasses'] if p['venue'] == venue]
        item['schedulers'][venue] = {**stats([p['elapsedMs'] for p in passes]), 'callsPerPass': sorted(set(p['calls'] for p in passes))}
    summary.append(item)
(root / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print('Workload | Takes detail median/p95 | queries/load | idle history/messages/portfolio/inbox p95 | burst portfolio p95/max')
for s in summary:
    print(s['name'], '|', round(s['details']['p50'], 1), '/', round(s['details']['p95'] or 0, 1), '|', s['detailQueryCounts'], '|',
          [round(s['idle'][p]['p95'], 1) for p in ['take-history-list', 'messages', 'portfolio', 'inbox']], '|',
          round(s['backgroundWindow']['portfolio']['p95'], 1), '/', round(s['backgroundWindow']['portfolio']['max'], 1))
