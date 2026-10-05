"""W7 unified technical evidence checks, separate from human acceptance."""
import hashlib,json,subprocess,sys
from pathlib import Path
from check_a_review import check_review, validate_technical_validation

root=Path(__file__).resolve().parents[1]
task=sys.argv[1] if len(sys.argv)==2 else ''
if task=='A043':
    sys.exit(check_review(root))
if task!='A044':
    print(json.dumps({'status':'failed','checks_run':0,'reason':'unsupported handoff task'}));sys.exit(2)
records={}
for number in range(1,44):
    path=root/f'artifacts/tasks/A{number:03d}.json'
    if not path.is_file():
        print(json.dumps({'status':'failed','checks_run':len(records),'reason':f'missing {path.name}'}));sys.exit(1)
    records[f'A{number:03d}']=json.loads(path.read_text(encoding='utf-8'))
failures=[task for task,record in records.items()
          if record.get('status')!='passed' or record.get('exit_code')!=0
          or record.get('test_count',0)<=0 or record.get('skipped_count',0)!=0]
try:
    technical=validate_technical_validation(root,'A043')
except (ValueError, OSError) as error:
    failures.append(str(error))
if failures:
    print(json.dumps({'status':'failed','checks_run':len(records),'reason':'failed local tasks: '+','.join(failures)}));sys.exit(1)
if not (root/'docs/runbooks/accounting.md').is_file():
    print(json.dumps({'status':'failed','checks_run':len(records),'reason':'runbook missing'}));sys.exit(1)
paths=[]
for directory in ['contracts/src','reference/a','reference/fixtures/a','packages/risk-sdk/src']:
    paths += [p for p in (root/directory).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
manifest={'status':'UNIFIED_TECHNICAL_HANDOFF','economic_baseline':'1.0','plan_version':'1.1',
    'scope':'Historical A task checks and current adversarial regressions; human gate acceptance recorded separately',
    'source_commit':technical['source_commit'],'validation_mode':'unified_team_technical_validation',
    'technical_evidence':technical['evidence'],'gates':'docs/spec/gate_status.json',
    'local_tasks':{t:{'status':r['status'],'tests':r['test_count'],'evidence':f'artifacts/tasks/{t}.json'} for t,r in records.items()},
    'module_hashes':{p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(paths)},
    'components':{'A':'real','B':'real in integration/review tests; scripted decisions in legacy A unit tests',
        'book':'real in applicable review regressions; legacy tests retain mocks',
        'price_source':'test observations','oracle':'scripted fixtures; live integration not certified',
        'token':'test fixtures; production collateral not certified'},
    'release_defaults':{'funding_enabled':False,'recovery_enabled':False,'conversion_enabled':False,'B_leverage_caps_required':1},
    'production_approved':False,'independent_review':False,'independent_audit':False,
    'live_counterpart_status':'NOT_ASSESSED_BY_THIS_RUNNER',
    'gas':'artifacts/risk/gas-accounting.json','custody':'artifacts/risk/custody-reconciliation.json','runbook':'docs/runbooks/accounting.md'}
out=root/'artifacts/risk/accounting-release.json';out.parent.mkdir(parents=True,exist_ok=True)
out.write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'status':'passed','checks_run':len(records)+1,'reason':'Unified technical evidence assembled; no peer approval, human acceptance or live certification granted.'}))
