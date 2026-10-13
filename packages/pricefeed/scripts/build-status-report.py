#!/usr/bin/env python3
"""Create a source-grounded status report; never reruns or manufactures demo data."""
import datetime as dt
import hashlib
import json
import subprocess
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether
from reportlab.graphics.shapes import Drawing, Line, String, PolyLine, Circle

PACKAGE = Path(__file__).resolve().parents[1]
ROOT = PACKAGE.parents[1]
OUTPUT = PACKAGE/'output/pdf'
OUTPUT.mkdir(parents=True, exist_ok=True)
DEMO = json.loads((PACKAGE/'artifacts/demo/latest.json').read_text())
CHECKS = json.loads((PACKAGE/'artifacts/verification/checks.json').read_text())
ENGINE = json.loads((PACKAGE/'artifacts/verification/engine.json').read_text())
# Narrative below documents this retained run, rather than any future latest.json.
assert DEMO['startedAtMs'] == '1790959881522', 'Demo evidence changed; review report narrative before regenerating'
ACCEPTED = [item for item in DEMO['attempts'] if 'accepted' in item]
assert DEMO['completed'] and DEMO['evidenceIntegrity'] and len(ACCEPTED) == DEMO['acceptedPackets']
assert all(item['twap']['verified'] for item in ACCEPTED)
assert all(check['exitCode'] == 0 for check in CHECKS['checks'])
TESTS = next(check['tests'] for check in CHECKS['checks'] if check['command'][-1] == 'test')
assert TESTS == 170 and ENGINE['tests'] == 4
LAST = ACCEPTED[-1]
OBS = LAST['packet']['obs']
FIRST_FULL = next(item for item in ACCEPTED if item['twap']['available'])
ARCHIVE = PACKAGE/DEMO['sourceArchive']
import sqlite3
db = sqlite3.connect(ARCHIVE.as_uri()+'?mode=ro', uri=True)
records = db.execute('SELECT payload,sha256 FROM captures ORDER BY id').fetchall()
db.close()
assert all(hashlib.sha256(payload.encode()).hexdigest() == digest for payload,digest in records)
first_capture = json.loads(records[0][0])
QUESTION = first_capture['metadata']['data']['question']
HEAD = subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
scope = subprocess.run(['python3','scripts/check-scope.py'],cwd=PACKAGE,capture_output=True,text=True)
assert scope.returncode == 0, scope.stdout+scope.stderr

for name, path in [('Body','DejaVuSans.ttf'),('Bold','DejaVuSans-Bold.ttf'),('Mono','DejaVuSansMono.ttf')]:
    pdfmetrics.registerFont(TTFont(name, '/usr/share/fonts/truetype/dejavu/'+path))
pdfmetrics.registerFontFamily('Body',normal='Body',bold='Bold',italic='Body',boldItalic='Bold')
INK = colors.HexColor('#182B3A')
TEAL = colors.HexColor('#087F8C')
GRAY = colors.HexColor('#556570')
PALE = colors.HexColor('#EFF5F7')
LINE = colors.HexColor('#D6E1E6')
AMBER = colors.HexColor('#8A5716')
W = A4[0]-88
styles = {
    'body': ParagraphStyle('body',fontName='Body',fontSize=9.4,leading=14,textColor=INK,spaceAfter=8),
    'small': ParagraphStyle('small',fontName='Body',fontSize=8.1,leading=11.5,textColor=GRAY,spaceAfter=6),
    'h1': ParagraphStyle('h1',fontName='Bold',fontSize=23,leading=28,textColor=INK,spaceAfter=12),
    'h2': ParagraphStyle('h2',fontName='Bold',fontSize=12,leading=16,textColor=TEAL,spaceBefore=13,spaceAfter=8),
    'eyebrow': ParagraphStyle('eyebrow',fontName='Bold',fontSize=8.3,leading=12,textColor=TEAL,spaceAfter=9),
    'cell': ParagraphStyle('cell',fontName='Body',fontSize=8.2,leading=11.7,textColor=INK),
    'head': ParagraphStyle('head',fontName='Bold',fontSize=8.2,leading=11.7,textColor=colors.white),
    'mono': ParagraphStyle('mono',fontName='Mono',fontSize=7.1,leading=10,textColor=INK,wordWrap='CJK'),
    'note': ParagraphStyle('note',fontName='Bold',fontSize=9,leading=13,textColor=TEAL),
}
story = []

def p(text, style='body'):
    return Paragraph(text, styles[style])

def add(text, style='body'):
    story.append(p(text,style))

def section(text):
    add(text,'h2')

def table(headers, rows, widths=None, small=False):
    data = [[p(escape(str(value)),'head') for value in headers]]
    data += [[value if isinstance(value,Paragraph) else p(escape(str(value)),'small' if small else 'cell') for value in row] for row in rows]
    result = Table(data,colWidths=widths or [W/len(headers)]*len(headers),hAlign='LEFT',repeatRows=1)
    result.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,0),INK),('VALIGN',(0,0),(-1,-1),'TOP'),
        ('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),9),
        ('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7),
        ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,PALE]),
        ('LINEBELOW',(0,0),(-1,0),0.6,INK),('LINEBELOW',(0,1),(-1,-1),0.35,LINE),
    ]))
    story.append(result)
    story.append(Spacer(1,6))

def price(value):
    whole,fraction = divmod(int(value),10**18)
    suffix = str(fraction).zfill(18).rstrip('0')
    return str(whole)+('.'+suffix if suffix else '')

def stamp(value):
    return dt.datetime.fromtimestamp(int(value)//1000,dt.timezone.utc).strftime('%d %b %Y %H:%M:%S UTC')

def page_title(number,title,subtitle):
    if number > 1: story.append(PageBreak())
    add(f'EROS MARKETS / CP-PRICE / {number:02d}','eyebrow')
    add(title,'h1')
    add(subtitle,'small')

def coverage_chart():
    drawing = Drawing(W,150)
    left,bottom,plot_w,plot_h = 35,28,W-55,96
    for level in [0,100,200,300]:
        y = bottom+level*plot_h/300
        drawing.add(Line(left,y,left+plot_w,y,strokeColor=LINE,strokeWidth=0.5))
        drawing.add(String(left-7,y-3,str(level),fontName='Body',fontSize=7.5,textAnchor='end',fillColor=GRAY))
    for second in [0,60,120,180,240,300,360]:
        x=left+second*plot_w/360
        drawing.add(String(x,bottom-13,str(second),fontName='Body',fontSize=7.5,textAnchor='middle',fillColor=GRAY))
    points=[]
    for item in ACCEPTED:
        elapsed=(int(item['atMs'])-int(DEMO['startedAtMs']))//1000
        covered=int(item['twap']['coveredSecs'])
        points.extend([left+elapsed*plot_w/360,bottom+covered*plot_h/300])
    drawing.add(PolyLine(points,strokeColor=TEAL,strokeWidth=2))
    full_elapsed=(int(FIRST_FULL['atMs'])-int(DEMO['startedAtMs']))//1000
    x=left+full_elapsed*plot_w/360
    drawing.add(Circle(x,bottom+plot_h,3.2,fillColor=TEAL,strokeColor=TEAL))
    drawing.add(String(left,138,'Covered seconds in the 300-second index window',fontName='Bold',fontSize=8.2,fillColor=INK))
    drawing.add(String(left+plot_w,bottom-25,'Elapsed seconds since demo start',fontName='Body',fontSize=7.5,textAnchor='end',fillColor=GRAY))
    return drawing

page_title(1,'Polymarket price feed<br/>Implementation status','Prepared 03 October 2026 | Evidence from 02 October 2026 | Local demo verified; production incomplete')
add('<b>What we were trying to build</b>','h2')
add('One configurable offchain service that repeatedly reads independently priced Polymarket event-outcome books, validates each approved mapping, calculates depth-N prices and delivers signed observations to the correct Eros risk engine. Sports, politics and crypto share the service, with independent market workers.')
add('The risk side owns authentication, validity, the 300-second index TWAP, mark and risk logic. The feed supplies depth observations; it does not decide event outcomes or send raw BTC/USD in place of a prediction-outcome price.')
section('What has been achieved')
table(['Verified result','Evidence'],[
    ('170 package tests passed','Configuration, exact math, time, source validation, journal/worker behavior, wire and demo checks.'),
    ('4 real-ingress/store tests passed','Raw signatures, altered domains/fields, duplicates, complete TWAP coverage and invalid transitions.'),
    ('36 / 36 real-source packets accepted','Actual Polymarket data signed and delivered through submitObservation on an owned local chain.'),
    ('300 / 300 seconds covered','Final engine index TWAP 0.765; all 36 index checks matched independent integration.'),
    ('1,156 protected file hashes unchanged','Risk, CLOB, oracle and other protected code preserved; changes confined to the price-feed package.'),
],[180,W-180])
section('Readiness and scope')
add('<b>Live Polymarket data testing is already complete for the bounded demo.</b> The remaining work is approved operational policy, reliable production delivery, continuous operation and real counterpart integration. The successful demo is not a production release or human gate acceptance.')
add('General CLI collection still emits diagnostics with engineObservation=null. The separate demo runner signs and sends only to its own localhost chain, using public test keys. Full margin, funding, settlement, Eros CLOB and oracle logic were not run or modified. External-chain transactions: zero.','small')

page_title(2,'Live-data demo','Actual event and output | Real ingress/store on a local test chain')
add('<b>'+escape(QUESTION)+'</b>')
add('Selected outcome: <b>Yes</b>. Polymarket event 1112205; market 5170735. The bot watches the selected outcome token and prices its book; it does not answer the question or resolve the event.')
add('Components called: <b>Gamma event/market API</b> -> <b>Polymarket complete-book API</b> -> <b>feed validator and depth calculator</b> -> <b>raw test signer</b> -> <b>PriceIngress.submitObservation</b> -> <b>ObservationStore.indexTwap300</b>.','small')
table(['Demo setting','Recorded value'],[
    ('Run start / finish',stamp(DEMO['startedAtMs'])+' / '+stamp(DEMO['finishedAtMs'])),
    ('Duration and polling','351.650 seconds recorded; 360-second maximum requested; 10-second target interval.'),
    ('Calculation policy','Diagnostic VWAP; N=1,000,000 lots (1,000 claims); maximum absolute spread=0.05.'),
    ('Receiver',p('Local chain 31337<br/><font name="Mono" size="7">'+DEMO['engineAddress']+'</font>','cell')),
],[135,W-135])
table(['Final bot / receiver value','Result'],[
    ('Impact bid / impact ask',price(OBS['impactBidWad'])+' / '+price(OBS['impactAskWad'])),
    ('Signed midpoint / priceWad',price(OBS['priceWad'])+' / '+OBS['priceWad']),
    ('Bid / ask depth (lots)',f"{int(OBS['bidDepthLots']):,} / {int(OBS['askDepthLots']):,}"),
    ('Sequence / depthValid','36 / true'),
    ('Engine 300-second index',price(LAST['twap']['twapWad'])+'; available=true; coveredSecs=300'),
],[220,W-220])
story.append(coverage_chart())
add('Coverage is queried after each accepted packet. It first reaches 300 seconds at sequence 31. Actual source time was preserved; no accelerated clock or fabricated backfill created this window.','small')
add('Demo-only choices include publication time, impact method/N/spread, quote convention and a hash of the demo manifest. These do not approve an Eros listing or settle Q02-Q10.','small')

page_title(3,'Tests and verification','Recorded checks, genuine-source evidence and practical limits')
table(['Check / command','Result','What it verifies'],[
    ('npm run typecheck','Exit 0','Strict TypeScript compilation and bigint interfaces.'),
    ('npm run test:reference','Exit 0 / 144 vectors','Independent Fraction fixtures, seed 20261002; regeneration matches.'),
    ('npm test','Exit 0 / 170 tests','No skipped, cancelled or todo tests. Includes the 144 arithmetic vectors.'),
    ('npm run check:wire','Exit 0','Eleven-field ABI, exact type string and raw encoding order match risk source.'),
    ('npm run check:scope','Exit 0','All 1,156 protected hashes unchanged; working diff stays in this package.'),
    ('npm run test:engine','Exit 0 / 4 tests','Real imported PriceIngress and ObservationStore; test-only initialization.'),
    ('demo:live (360-second cap)','Exit 0 / 36 accepted','Actual source data, raw digest equality, accepted events, source sequence and independent TWAP.'),
    ('Archive/report checks','Pass / exit 0','Capture SHA-256 integrity, retained source book and report generation.'),
],[145,100,W-245])
add('The 144 reference vectors are included in the 170 package tests; they are not 144 additional test cases. The four Solidity ingress tests are a separate suite. Recorded full verification: 02 Oct 2026, 16:53:42 UTC.','small')
section('Failure behavior already tested')
add('Checks cover malformed/tick-invalid books, fractional and duplicate levels, thin/crossed/wide books, stale/future/backwards time, wrong event/token/condition, changed rules, bounded retries and hanging fetch/body timeouts. Wire tests mutate fields/domains and compare raw versus prefixed signing. Worker/journal tests cover restart ordering, sticky quarantine, writer fencing and an isolated source outage.')
section('Earlier source evidence also showed failures')
add('The initial smoke check fetched six books across crypto, sports and politics, all HTTP 200. A separate 600-second diagnostic run attempted 183 books: 123 HTTP 200, 122 fresh at receipt and 108 diagnostically eligible; 60 connection resets occurred. A later 30-second run collected crypto and politics (three samples each) while sports correctly reported EMPTY_BOOK_SIDE for all three samples.')
add('These runs demonstrate access and visible unavailability, not guaranteed availability. Only the Bitcoin local-chain demo supplied signed live-data ingress evidence. Cricket mapping, broad category signed soaks, production crash/reorg campaigns and full lifecycle integration remain unverified.','small')
add('Pinned runtime: Node 24.21.0; TypeScript 5.9.3; viem 2.57.2; Forge/Anvil 1.8.3; Solidity 0.8.30. Wrong global Forge 1.5.1 was rejected; sandbox network/localhost failures required authorized retries.','small')

page_title(4,'Remaining work','What blocks production and what can proceed independently')
table(['Workstream','Required completion','Dependency'],[
    ('Approved policies','Exact event/outcome/exception mapping; impact method, rounding, fees, units, source/publication time, rules hash and invalid-packet policy.','Risk + feed + oracle/listing/factory: Q02-Q06, Q08; I-3 confirmation.'),
    ('Durable delivery','Persist signed sequences/outbox; immutable retry packets, shared nonce management, unknown-send recovery, receipts and reorg/finality reconciliation.','Local test preparation can proceed; operational behavior requires applicable approvals and Q09 environment.'),
    ('Continuous operations','Long-running service, controlled restart, observability/alerts, retention, capacity and approved source/signing/inclusion budgets.','Operator + risk: Q07, Q10.'),
    ('Lifecycle correctness','Invalid-summary delivery, closure/outages and continued index recording after early halt when INVALID history requires it.','Agreed failure policy and real oracle/listing lifecycle integration.'),
    ('Authorized connection','Actual chain/RPC/engine/code/ABI, pinned source/signer/rules, secure raw signer and bounded transaction authority.','Factory/listing + production + risk: Q09. Public demo keys are not operational keys.'),
    ('Release evidence','Approved longer soaks and load/fault campaigns; calibrated N/spread; security review, runbooks, counterpart integration and human release acceptance.','Risk + operator + production: Q10; real CLOB/oracle for complete economics/lifecycle.'),
],[105,245,W-350])
section('Recommended next steps')
add('<b>1.</b> Record one initial market mapping and the applicable semantic decisions with owner, date and evidence. Do not infer approval from example settings.')
add('<b>2.</b> Build/test reliable persistence, recovery and continuous operation inside the price-feed package, using local/test modes while dependent operational decisions remain open.')
add('<b>3.</b> Join an authorized initialized engine after its source/signer/rules pins are confirmed. Run final economic and halt/outcome integration when the real Eros CLOB and oracle are available.')
add('<b>No wait is needed for independent collection or local test development.</b> Production acceptance needs the applicable approvals and real counterparts. Real Polymarket access has already been demonstrated; remaining tests address reliability and authorized integration.','note')

page_title(5,'Output contract and evidence','Exact risk input, provenance and interpretation')
add('The feed calls <font name="Mono" size="9">submitObservation(Observation obs, bytes signature)</font>. The eleven fields below are in ABI order; IDs/hashes are demo pins for this run. Times are Unix seconds, prices WAD (10^18), and one lot is 0.001 claim.','small')
fields=[('marketId','bytes32'),('sourceId','bytes32'),('sequence','uint64'),('observedAt','uint64'),('publishedAt','uint64'),('priceWad','uint256'),('impactBidWad','uint256'),('impactAskWad','uint256'),('bidDepthLots','uint256'),('askDepthLots','uint256'),('sourceRulesHash','bytes32')]
table(['Field','Type','Last submitted demo value'],[(name,kind,p(escape(OBS[name]),'mono')) for name,kind in fields],[127,61,W-188])
add('Digest: raw keccak256(abi.encode(TYPEHASH, eleven fields, chainId, engine)). No personal-message or EIP-712 prefix. Chain ID and engine bind the signature domain. acceptedAt, depthValid and payloadDigest are receiver outputs. The feed does not send a precomputed index TWAP or final mark.','small')
section('Evidence snapshot')
add('Repository HEAD: <font name="Mono" size="7.8">'+HEAD+'</font>. Test manifest HEAD: <font name="Mono" size="7.8">'+CHECKS['headCommit']+'</font>. Evidence includes working-tree changes and source hashes; no new commit or human approval is claimed.','small')
refs=[('artifacts/demo/latest.json','Signed packets, accepted events and engine/reference results'),('artifacts/verification/checks.json','Command exits, source hashes and test count'),('artifacts/verification/engine.json','Pinned toolchain and four real-ingress tests')]
for relative,description in refs:
    digest=hashlib.sha256((PACKAGE/relative).read_bytes()).hexdigest()
    add('<b>'+escape(relative)+'</b> - '+escape(description)+'<br/><font name="Mono" size="7">SHA-256 '+digest+'</font>','small')
add('Paths above are relative to packages/pricefeed/. Further evidence: artifacts/demo/source-example.json; '+escape(DEMO['sourceArchive'])+' (ignored raw SQLite archive); PROGRESS.md; docs/decisions.md. Source plan: docs/requests/polymarket-event-price-feed-implementation-plan.pdf, v1.0, 02 Oct 2026. Existing interfaces: IPriceSource.sol, PriceIngress.sol and ObservationStore.sol.','small')
add('No tests or network demo were rerun to create this report. It summarizes retained, verified evidence. No risk/CLOB/oracle internals, approval fingerprints, shared gate/STATUS files or production settings were changed.','small')

def page(canvas,doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE);canvas.setLineWidth(0.5)
    canvas.line(44,39,A4[0]-44,39)
    canvas.setFillColor(GRAY);canvas.setFont('Body',7.3)
    canvas.drawString(44,26,'CP-PRICE | Implementation evidence | Production incomplete')
    canvas.drawRightString(A4[0]-44,26,f'{doc.page} / 5')
    canvas.restoreState()

target=OUTPUT/'pricefeed-implementation-status-report.pdf'
document=SimpleDocTemplate(str(target),pagesize=A4,rightMargin=44,leftMargin=44,topMargin=40,bottomMargin=52,
    title='Polymarket price-feed implementation status',author='Eros Markets / CP-PRICE',subject='Achieved implementation, verified real-data demo, tests and remaining work')
document.build(story,onFirstPage=page,onLaterPages=page)
print(target)
