import assert from 'node:assert/strict';
import {test} from 'node:test';
import {marketChip} from '../src/lib/enums.ts';
import {lockWalletTransaction} from '../src/lib/transaction-lock.ts';
import {parseClaimsToLots,parseUsdcToAtoms} from '../src/lib/units.ts';
test('separate panels cannot run competing sequences from the same wallet',()=>{
 const release=lockWalletTransaction(10143,'0xAbc');
 try {
  assert.throws(()=>lockWalletTransaction(10143,'0xabc'),/already in progress/);
  const other=lockWalletTransaction(10143,'0xDef');other();
 } finally {release();}
 lockWalletTransaction(10143,'0xabc')();
});
test('amount parsing rejects values outside the contract ABI before an RPC request',()=>{
 const max=(1n<<64n)-1n;
 assert.equal(parseClaimsToLots(`${max/1000n}.${String(max%1000n).padStart(3,'0')}`),max);
 assert.throws(()=>parseClaimsToLots(`${max/1000n+1n}`),/contract limit/);
 assert.throws(()=>parseUsdcToAtoms((1n<<256n).toString()),/contract limit/);
});

test('normal pricing mode alone never labels a stale-price market as trading',()=>{
 const market={active:true,halted:false,stage:0,pricingMode:1,accountingState:0,indexAvailable:true,markAvailable:true,monitorRestricted:false,claimsEnabled:false,phase:0,recoveryRequired:false,oracleFinalityAccepted:false};
 assert.equal(marketChip(market).label,'Trading');
 assert.equal(marketChip({...market,markAvailable:false}).label,'Waiting for fresh prices');
 assert.equal(marketChip({...market,indexAvailable:false}).label,'Waiting for fresh prices');
});
