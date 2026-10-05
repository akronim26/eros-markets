"""Canonical receipt and actual-position checks for the real-source owned-Anvil run."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SPEC = importlib.util.spec_from_file_location('local_audit', Path(__file__).with_name('audit-local-run.py'))
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


def check_state_audit(directory, actors, snapshot, source):
    state = json.loads((directory / 'live-state-audit.json').read_text())
    if (state.get('mode') != 'LOCAL_LIVE_STATE_AUDIT' or state.get('passed') is not True
            or state.get('chainId') != 31337 or state.get('publicTransactions') != 0
            or state.get('canonicalOwnerStatesVerified') is not True
            or state.get('collateralAndCashVerifiedFromTransactions') is not True):
        raise RuntimeError('Canonical live state audit missing or incomplete')
    for name, filename in [('manifest', 'manifest.json'), ('actors', 'live-actors.json'),
                           ('snapshot', 'snapshot-final.json'), ('pricefeed', 'pricefeed-audit.json')]:
        if state['inputSha256'][name] != hashlib.sha256((directory / filename).read_bytes()).hexdigest():
            raise RuntimeError('Live audit input changed after canonical verification')
    if (state['engine'].lower() != actors['engine'].lower()
            or state['listingHash'].lower() != actors['listingHash'].lower()
            or state['trade']['block']['hash'].lower() != actors['trade']['blockHash'].lower()
            or state['finalState']['block']['hash'].lower() != snapshot['block']['hash'].lower()
            or state['actualPostTradeSample']['hash'].lower() != actors['postTradeSample']['transactionHash'].lower()
            or source.get('passed') is not True or source.get('canonicalReceiptsVerified') is not True):
        raise RuntimeError('Live audit checkpoints do not bind the actor/source reports')
    return state


def ensure_state_audit(directory):
    output = directory / 'live-state-audit.json'
    if output.exists():
        return
    bun = os.environ.get('LOCAL_BUN') or shutil.which('bun')
    if not bun:
        raise RuntimeError('Bun is required for the canonical live-state audit')
    oracle = Path(__file__).resolve().parents[2] / 'oracle'
    result = subprocess.run([bun, '--no-env-file', 'services/local-integration/src/audit-live.ts',
                             str(directory / 'manifest.json'), str(directory / 'live-actors.json'),
                             str(directory / 'snapshot-final.json'), str(directory / 'pricefeed-audit.json'), str(output)],
                            cwd=oracle, capture_output=True, text=True, timeout=600,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if result.returncode:
        (directory / 'live-state-audit.log').write_text(result.stdout + result.stderr, encoding='utf-8')
        raise RuntimeError('Canonical live-state audit failed; inspect live-state-audit.log')


def main():
    directory = Path(sys.argv[1]).resolve()
    runtime = json.loads((directory / 'runtime.json').read_text())
    if runtime.get('sourceMode') != 'polymarket' or int(AUDIT.STACK.rpc_call(runtime['rpcUrl'], 'eth_chainId'), 16) != 31337:
        raise RuntimeError('Real-source local deployment required')
    actors = json.loads((directory / 'live-actors.json').read_text())
    if not actors.get('complete') or not actors.get('trade') or not actors.get('postTradeSample'):
        raise RuntimeError('Live leveraged proof incomplete')
    trade = actors['trade']
    if [int(a['positionLots']) for a in trade['accounts']] != [100000, -100000]:
        raise RuntimeError('Live positions mismatch')
    if any(int(a['e0Q']) >= 0 and int(a['e1Q']) >= 0 for a in trade['accounts']):
        raise RuntimeError('A claimed leveraged position is fully backed')
    if any(int(slack) < 0 for slack in trade['slacks']):
        raise RuntimeError('Negative outcome coverage')
    deployed = json.loads((directory / 'deploy-receipts.json').read_text())
    snapshot = json.loads((directory / 'snapshot-final.json').read_text())
    source = json.loads((directory / 'pricefeed-audit.json').read_text())
    ensure_state_audit(directory)
    state = check_state_audit(directory, actors, snapshot, source)
    for checkpoint in [state['trade']['block'], state['finalState']['block'], state['actualPostTradeSample']['block']]:
        canonical = AUDIT.STACK.rpc_call(runtime['rpcUrl'], 'eth_getBlockByNumber', [hex(int(checkpoint['number'])), False])
        if not canonical or canonical['hash'].lower() != checkpoint['hash'].lower():
            raise RuntimeError('Canonical live-state audit checkpoint was reorganized')
    # One combined verification rejects duplicate hashes across deployment, actors,
    # INDEX delivery and sampler roles rather than counting separate reports twice.
    receipts = AUDIT.verify_receipts(runtime['rpcUrl'], deployed['receipts'] + actors['receipts']
                                    + source['publisherReceipts'] + source['samplerReceipts'])
    demo = next(market for market in snapshot['markets'] if market['name'] == 'demo')
    accounts = {value['name']: value['risk'] for value in demo['accounts']}
    for name, lots in [('leveragedLong', 100000), ('leveragedShort', -100000)]:
        if int(accounts[name]['positionLots']) != lots:
            raise RuntimeError('Final snapshot does not contain the mined leveraged positions')
    if demo['reserveCoverage']['recoveryEnabled'] or int(snapshot['custodyAtoms']) < int(snapshot['recognizedAtoms']):
        raise RuntimeError('Recovery or custody mismatch')
    result = {'passed': True, 'sourceMode': 'polymarket', 'chainId': 31337, 'publicTransactions': 0,
              'canonicalReceipts': receipts, 'trade': trade, 'postTradeSample': actors['postTradeSample'],
              'canonicalTradeState': state['trade'], 'canonicalFinalState': state['finalState'],
              'actualMatchedFill': state['actualMatchedFill'], 'actualPostTradeSample': state['actualPostTradeSample'],
              'receiptCounts': {'deployment': len(deployed['receipts']), 'actors': len(actors['receipts']),
                                'publisher': len(source['publisherReceipts']), 'sampler': len(source['samplerReceipts'])}}
    AUDIT.STACK.write_json(directory / 'receipt-audit.json', result)
    print(json.dumps({'passed': True, 'canonicalReceipts': len(receipts), 'publicTransactions': 0}))


if __name__ == '__main__':
    main()
