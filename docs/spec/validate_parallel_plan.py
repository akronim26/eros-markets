"""Validate scheduling/ownership only. Does not execute future protocol tests."""
from pathlib import Path
from collections import defaultdict
import json
P=Path(__file__).resolve().parent
tasks=json.loads((P/'risk_tasks.json').read_text()); gates=json.loads((P/'integration_gates.json').read_text()); migration=json.loads((P/'task_migration.json').read_text())
assert len(tasks)==88 and len(gates)==8
nodes={x['id']:x for x in tasks+gates}; assert len(nodes)==96
seen=set();visiting=set()
def visit(i):
 if i in seen:return
 assert i not in visiting,('cycle',i)
 assert i in nodes,('missing dependency',i)
 visiting.add(i)
 for d in nodes[i]['depends_on']:visit(d)
 visiting.remove(i);seen.add(i)
for i in nodes:visit(i)
owners=defaultdict(set);summary=[]
for t in tasks:
 assert t['owner'] in ['A','B'] and t['status']=='not_started'
 assert t['effort_points'] in range(1,6)
 w=int(t['wave'][1:])
 assert t['handoff_at']==f'G{w}'
 if w:assert f'G{w-1}' in t['depends_on']
 for d in t['depends_on']:
  dep=nodes[d]
  if 'wave' in dep:
   assert int(dep['wave'][1:])<=w
   if dep['wave']==t['wave']:assert dep['owner']==t['owner'],('same-wave peer dependency',t['id'],d)
  else:assert int(d[1:])<w
 for f in t['write_files']:owners[f].add(t['owner'])
 assert t['acceptance_command'] and t['acceptance'] and t['legacy_ids']
assert all(len(v)==1 for v in owners.values()),{k:list(v) for k,v in owners.items() if len(v)>1}
for w in range(8):
 row={'wave':f'W{w}'}
 for o in ['A','B']:
  group=[t for t in tasks if t['wave']==f'W{w}' and t['owner']==o]
  row[o]={'tasks':len(group),'points':sum(t['effort_points'] for t in group)}
 assert row['A']['points']==row['B']['points']
 g=nodes[f'G{w}'];required={t['id'] for t in tasks if t['wave']==f'W{w}'}
 assert set(g['depends_on'])==required
 assert g['coordinator']==('A' if w%2==0 else 'B')
 summary.append(row)
for o in ['A','B']:
 assert len([t for t in tasks if t['owner']==o])==44
 assert sum(t['effort_points'] for t in tasks if t['owner']==o)==157
# No stateful implementation before the math gate; W0–W2 write only reference,
# pure math, types, test/tooling/contracts docs or declared math tests.
for t in tasks:
 if int(t['wave'][1:])<=2:
  for f in t['write_files']:
   assert not f.startswith(('contracts/src/risk/','contracts/src/vaults/','contracts/src/pricing/','contracts/src/settlement/')),('math-first violation',t['id'],f)
# G2 is an ancestor of every stateful task.
def ancestors(i):
 a=set()
 for d in nodes[i]['depends_on']:a.add(d);a.update(ancestors(d))
 return a
# Memoize to avoid repeated graph walking.
from functools import lru_cache
ancestors=lru_cache(None)(ancestors)
for t in tasks:
 if int(t['wave'][1:])>=3:assert 'G2' in ancestors(t['id'])
expected={f'R{i:03}' for i in range(1,81)}
assert {m['old_id'] for m in migration}==expected
assert set(x for t in tasks for x in t['legacy_ids'])==expected
for m in migration:
 assert set(m['new_ids'])=={t['id'] for t in tasks if m['old_id'] in t['legacy_ids']}
 for x in m['new_ids']:assert x in nodes
result={'status':'passed','plan_version':'1.1','economic_baseline':'1.0','task_count':88,'tasks_per_person':44,'gate_count':8,'task_points_per_person':157,'shared_gate_points_per_person':16,'planned_total_per_person':173,'effort_note':'Relative planning estimates, not hours or measured equality.','graph':'acyclic','same_wave_peer_task_dependencies':0,'cross_owner_write_file_collisions':0,'legacy_tasks_mapped':80,'stateful_tasks_require_G2':True,'wave_balance':summary,'scope':'Plan structure only; future repository implementation and acceptance commands not run.'}
(P/'parallel_plan_validation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
