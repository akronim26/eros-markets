"""A040 independent multi-fill trace and endpoint-solvency reference campaign."""
import json,random,hashlib
from pathlib import Path
from fractions import Fraction as F
from reference.a.ledger import Account,fill,equity
from reference.a.coverage import deficits,slacks
from reference.common.units import Q,REFERENCE_SEED

def run(root):
    rng=random.Random(REFERENCE_SEED);a=Account(0,120_000_000*Q);b=Account(0,100_000_000*Q)
    reserve=Account(0,100_000_000_000*Q);fees=0;rows=[]
    for i in range(2000):
        buy_a=i%2==0;lots=rng.randint(1,1000);tick=rng.randint(1,999);bf=3;sf=7
        if buy_a:a,b,f=fill(a,b,lots,tick,bf,sf)
        else:b,a,f=fill(b,a,lots,tick,bf,sf)
        fees+=f;assert a.lots+b.lots==0
        assert a.cash_q+b.cash_q+fees==220_000_000*Q
        d0a,d1a=deficits(a);d0b,d1b=deficits(b)
        assert min(slacks(reserve,d0a+d0b,d1a+d1b))>=0
        for p in (F(0),F(1,2),F(1)):
            assert max(0,equity(a,p))+max(0,equity(b,p))+fees<=100_220_000_000*Q
        if i<64:rows.append([int(buy_a),lots,tick,bf,sf,int(a.cash_q),int(b.cash_q),a.lots,b.lots])
    src=['// SPDX-License-Identifier: MIT','pragma solidity ^0.8.30;','// Independent Fraction reference output.','library IntegratedVectors {',f'function trace() internal pure returns(int256[9][] memory v) {{ v=new int256[9][]({len(rows)});']
    for i,row in enumerate(rows):src.append(f'v[{i}]=[int256({row[0]}),'+','.join(str(x) for x in row[1:])+'];')
    src+=['}','}'];path=root/'contracts/test/invariant/A/IntegratedVectors.sol';path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text('\n'.join(src)+'\n')
    report={'scope':'A-only independent rational transitions','seed':hex(REFERENCE_SEED),'transitions':2000,'solidity_trace_rows':64,'status':'passed','fixture_sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
    dest=root/'artifacts/risk/reference-campaign.json';dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))
if __name__=='__main__':run(Path(__file__).resolve().parents[2])
