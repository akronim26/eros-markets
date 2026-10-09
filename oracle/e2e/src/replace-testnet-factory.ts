/** Replace immutable engine code using a rehearsed, journaled governance plan. */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { encodeDeployData, encodeFunctionData, getContractAddress, keccak256, parseEther, stringToHex, type Address, type Hex } from 'viem';
import { artifact, atomicWrite, client, executePlan, MODE, operation, runtimeMatches, type Plan, type Step } from './fresh-testnet';
import { loadArtifacts } from './integrated-preflight';
const [command, input, previous] = process.argv.slice(2), directory=resolve(input??''), rpc=process.env.MONAD_TESTNET_RPC;
const read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
const json=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x,2)+'\n';
async function verify(p:Plan, pc:ReturnType<typeof client>['public'], journal:any){
 const old=read(resolve(directory,'previous-base-verification.json'));
 const block=await pc.getBlock({blockTag:journal.broadcast?'finalized':'latest'}),contracts={...old.contracts};
 const readAt=(contract:string,address:Address,functionName:string,args:unknown[]=[])=>pc.readContract({address,abi:artifact(contract).abi,functionName,args,blockNumber:block.number}) as Promise<any>;
 const engineCode=artifact('RegistryBookRiskEngine').bytecode.object as Hex;
 for(const step of p.steps.filter(s=>s.expectedAddress)){
  const code=await pc.getCode({address:step.expectedAddress!,blockNumber:block.number});
  const store=step.name==='deploy:EngineCodeStore'?`0x00${engineCode.slice(2,200002)}`:step.name==='deploy:EngineCodeStoreTail'?`0x00${engineCode.slice(200002)}`:null;
  if(!code||(store?code.toLowerCase()!==store.toLowerCase():!runtimeMatches(code,artifact(step.contract!).deployedBytecode)))throw Error('REPLACEMENT_RUNTIME_MISMATCH');
  const receipt=journal.steps.find((s:any)=>s.name===step.name);
  contracts[step.name.replace('deploy:','')]={address:step.expectedAddress,codehash:keccak256(code),deployBlock:Number(receipt.receipt.blockNumber),transactionHash:receipt.hash};
 }
 for(const [name,identity] of Object.entries(old.contracts) as [string,any][]){
  if(['EngineCodeStore','EngineCodeStoreTail','MarketFactory','CollateralVault'].includes(name))continue;
  const code=await pc.getCode({address:identity.address,blockNumber:block.number});
  if(!code||keccak256(code)!==identity.codehash)throw Error('EXISTING_DEPENDENCY_CHANGED');
 }
 const a=p.addresses,vault=await readAt('MarketFactory',a.MarketFactory,'collateralVault'),code=await pc.getCode({address:vault,blockNumber:block.number});
 if(!code||!runtimeMatches(code,artifact('CollateralVault').deployedBytecode))throw Error('VAULT_RUNTIME_MISMATCH');
 contracts.CollateralVault={address:vault,codehash:keccak256(code),deployBlock:contracts.MarketFactory.deployBlock};
 const pins:[string,Address,string,unknown][]=[['MarketRegistry',a.MarketRegistry,'factory',a.MarketFactory],['MarketFactory',a.MarketFactory,'registry',a.MarketRegistry],['MarketFactory',a.MarketFactory,'resolutionAuthority',a.ResolutionOracle],['MarketFactory',a.MarketFactory,'governance',a.Timelock],['MarketFactory',a.MarketFactory,'creationCodeHash',keccak256(engineCode)],['CollateralVault',vault,'token',a.TestUSDC],['CollateralVault',vault,'governor',a.MarketFactory]];
 for(const [contract,address,fn,expected] of pins)if(String(await readAt(contract,address,fn)).toLowerCase()!==String(expected).toLowerCase())throw Error('REPLACEMENT_BINDING_MISMATCH');
 if((await pc.getBlock({blockNumber:block.number})).hash!==block.hash)throw Error('VERIFICATION_BLOCK_REORGED');
 return {...old,passed:true,sourceCommit:p.sourceCommit,contracts,verifiedAt:{blockNumber:String(block.number),blockHash:block.hash},replacement:{previousFactory:old.contracts.MarketFactory.address,engineCreationHash:keccak256(engineCode),reason:'Monad testnet INDEX60/PERP60/BASIS180/carry30 pricing profile; hourly promotion and risk rules preserved',publicTransactions:journal.broadcast?journal.steps.length:0}};
}
try{
 if(!input||!rpc)throw Error('DEPLOYMENT_INPUTS_REQUIRED');
 if(command==='prepare'){
  if(!previous||existsSync(resolve(directory,'base-plan.json')))throw Error('NEW_DIRECTORY_AND_PREVIOUS_DEPLOYMENT_REQUIRED');
  loadArtifacts();mkdirSync(directory,{recursive:true,mode:0o700});
  const old=read(resolve(previous,'base-plan.json')) as Plan,oldVerified=read(resolve(previous,'base-verification.json'));
  if(!oldVerified.passed||old.chainId!==10143)throw Error('VERIFIED_PREVIOUS_DEPLOYMENT_REQUIRED');
  const pc=client(rpc).public,b=await pc.getBlock({blockTag:'finalized'}),nonce=await pc.getTransactionCount({address:old.deployer,blockTag:'latest'});
  if(await pc.getChainId()!==10143||nonce!==await pc.getTransactionCount({address:old.deployer,blockTag:'pending'}))throw Error('DEPLOYER_NOT_READY');
  const a={...old.addresses},steps:Step[]=[];
  const deploy=(name:string,args:unknown[],contract=name)=>{const n=nonce+steps.length,address=getContractAddress({from:old.deployer,nonce:BigInt(n)}),compiled=artifact(contract);steps.push({name:'deploy:'+name,nonce:n,expectedAddress:address,contract,data:encodeDeployData({abi:compiled.abi,bytecode:compiled.bytecode.object,args})});a[name]=address;return address;};
  const code=artifact('RegistryBookRiskEngine').bytecode.object as Hex;
  const head=deploy('EngineCodeStore',[`0x${code.slice(2,200002)}`]),tail=deploy('EngineCodeStoreTail',[`0x${code.slice(200002)}`],'EngineCodeStore');
  const factory=deploy('MarketFactory',[a.MarketRegistry,a.TestUSDC,old.deployer,head,tail,keccak256(code)]);
  const execution=operation([{to:a.MarketRegistry,value:0n,data:encodeFunctionData({abi:artifact('MarketRegistry').abi,functionName:'setFactory',args:[factory]})}],`eros-replace-factory:${factory}`);
  for(const [fn,args] of [['propose',[MODE,execution,300n]],['execute',[MODE,execution]]] as const)steps.push({name:'governance:'+fn+'-factory',nonce:nonce+steps.length,to:a.Timelock,data:encodeFunctionData({abi:artifact('Timelock').abi,functionName:fn,args}),...(fn==='execute'?{waitSeconds:300}:{})});
  const plan={...old,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),startNonce:nonce,preparedBlock:String(b.number),preparedBlockHash:b.hash,addresses:a,steps,maxTotalGasCostWei:parseEther('6').toString()};
  atomicWrite(resolve(directory,'base-plan.json'),plan);atomicWrite(resolve(directory,'previous-base-verification.json'),oldVerified);
  console.log(JSON.stringify({prepared:true,factory,engineCreationHash:keccak256(code),steps:steps.length}));
 }else if(command==='rehearse'||command==='broadcast'){
  const plan=read(resolve(directory,'base-plan.json'));
  if(command==='broadcast'){const rehearsal=read(resolve(directory,'rehearsal-journal.json'));if(rehearsal.status!=='passed'||rehearsal.planHash!==keccak256(stringToHex(json(plan))))throw Error('MATCHING_REHEARSAL_REQUIRED');}
  if(command==='rehearse'){await client('http://127.0.0.1:18568').public.request({method:'anvil_reset',params:[{forking:{jsonRpcUrl:'http://127.0.0.1:18569',blockNumber:Number(plan.preparedBlock)}}]} as never);await client('http://127.0.0.1:18568').public.request({method:'anvil_removeBlockTimestampInterval',params:[]} as never);}
  const lock=resolve(directory,'execution.lock');mkdirSync(lock);try{await executePlan(plan,directory,command==='broadcast'?rpc:'http://127.0.0.1:18568',command==='broadcast','base',verify);}finally{rmSync(lock,{recursive:true});}
 }else throw Error('UNKNOWN_COMMAND');
}catch(e){console.error((e as Error).message.match(/^[A-Z_]+(?::[^\s]+)?$/)?.[0]??'FACTORY_REPLACEMENT_FAILED');process.exitCode=1;}
