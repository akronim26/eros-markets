"""W7 document/evidence checks. Pending peer review is never reported as passed."""
import hashlib,json,subprocess,sys
from pathlib import Path

root=Path(__file__).resolve().parents[1]
task=sys.argv[1] if len(sys.argv)==2 else ''
if task=='A043':
    report=root/'artifacts/reviews/A-on-B.md'
    if not report.is_file():
        print(json.dumps({'status':'failed','checks_run':0,'reason':'missing A review handoff'}));sys.exit(1)
    print(json.dumps({'status':'pending_peer_merge','checks_run':1,
        'reason':'A review checklist and reproducers prepared; B implementation is absent. No completed peer review is claimed.'}));sys.exit(2)
if task!='A044':
    print(json.dumps({'status':'failed','checks_run':0,'reason':'unsupported handoff task'}));sys.exit(2)
records={}
for number in range(1,44):
    path=root/f'artifacts/tasks/A{number:03d}.json'
    if not path.is_file():
        print(json.dumps({'status':'failed','checks_run':len(records),'reason':f'missing {path.name}'}));sys.exit(1)
    records[f'A{number:03d}']=json.loads(path.read_text(encoding='utf-8'))
failures=[task for task,r in records.items() if r['status']!='passed' and task!='A043']
if records['A043']['status'] != 'blocked' or records['A043']['exit_code'] != 2:
    failures.append('A043 must explicitly record the unavailable peer review')
if failures:
    print(json.dumps({'status':'failed','checks_run':len(records),'reason':'failed local tasks: '+','.join(failures)}));sys.exit(1)
if not (root/'docs/runbooks/accounting.md').is_file():
    print(json.dumps({'status':'failed','checks_run':len(records),'reason':'runbook missing'}));sys.exit(1)
paths=[]
for directory in ['contracts/src/math','contracts/src/risk','contracts/src/vaults','contracts/src/settlement','reference/a','reference/fixtures/a','packages/risk-sdk/src']:
    paths += [p for p in (root/directory).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
manifest={'status':'A_LOCAL_HANDOFF_READY_PEER_MERGE_PENDING','economic_baseline':'1.0','plan_version':'1.1',
    'scope':'A only; all combined gates and B review pending merge','source_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),
    'local_tasks':{t:{'status':r['status'],'tests':r['test_count'],'evidence':f'artifacts/tasks/{t}.json'} for t,r in records.items()},
    'module_hashes':{p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(paths)},
    'components':{'A':'real','B':'scripted_mock','book':'not_integrated; unchanged','price_source':'scripted_context','oracle':'scripted_internal_calls','token':'MockUSDC'},
    'release_defaults':{'funding_enabled':False,'recovery_enabled':False,'conversion_enabled':False,'B_leverage_caps_required':1},
    'production_approved':False,'independent_audit':False,'live_counterpart_status':'PENDING_MERGE',
    'gas':'artifacts/risk/gas-accounting.json','custody':'artifacts/risk/custody-reconciliation.json','runbook':'docs/runbooks/accounting.md'}
out=root/'artifacts/risk/accounting-release.json';out.parent.mkdir(parents=True,exist_ok=True)
out.write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'status':'passed','checks_run':len(records)+1,'reason':'Local A evidence assembled; pending peer review and gates explicitly retained.'}))
