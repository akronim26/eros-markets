import { constants, closeSync, existsSync, fstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Hex } from 'viem';

const fixtures=['11'.repeat(32),'22'.repeat(32),'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'];
function account(key:string):PrivateKeyAccount {
  if(!/^0x[0-9a-fA-F]{64}$/.test(key))throw new Error('KEY_UNLOCK_FAILED');
  if(fixtures.includes(key.slice(2).toLowerCase()))throw new Error('PUBLIC_FIXTURE_KEY_FORBIDDEN');
  try{return privateKeyToAccount(key as Hex);}catch{throw new Error('KEY_UNLOCK_FAILED');}
}
function privateFile(path:string,limit:number):Buffer {
  let fd:number;
  try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);}catch{throw new Error('PRIVATE_FILE_REQUIRED');}
  try{
    const stat=fstatSync(fd);
    if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size>limit||stat.uid!==process.getuid?.())throw new Error('PRIVATE_FILE_REQUIRED');
    return readFileSync(fd);
  }finally{closeSync(fd);}
}
/** Testnet-only encrypted key custody. Paths/passwords/key values are never in errors. */
export function loadTestnetKey(path:string,passwordPath:string,expectedAddress:string):PrivateKeyAccount {
  const encrypted=privateFile(path,4096),password=privateFile(passwordPath,32);
  let key:string;
  try{
    const saved=JSON.parse(encrypted.toString('utf8'));
    if(saved.kind!=='TESTNET_ONLY_ENCRYPTED_RAW_OBSERVATION_SIGNER'||password.length!==32
      ||!/^([a-f0-9]{2}){32}$/.test(saved.salt)||!/^([a-f0-9]{2}){12}$/.test(saved.iv)
      ||!/^([a-f0-9]{2}){16}$/.test(saved.tag)||!/^([a-f0-9]{2}){66}$/.test(saved.ciphertext))throw new Error();
    const derived=scryptSync(password,Buffer.from(saved.salt,'hex'),32);
    const decipher=createDecipheriv('aes-256-gcm',derived,Buffer.from(saved.iv,'hex'));
    decipher.setAuthTag(Buffer.from(saved.tag,'hex'));
    key=Buffer.concat([decipher.update(Buffer.from(saved.ciphertext,'hex')),decipher.final()]).toString('utf8');
    derived.fill(0);
  }catch{throw new Error('KEY_UNLOCK_FAILED');}finally{password.fill(0);}
  const result=account(key);
  if(result.address.toLowerCase()!==expectedAddress.toLowerCase())throw new Error('KEY_IDENTITY_MISMATCH');
  return result;
}
/** Explicit setup helper; caller supplies a private directory. Never overwrites custody. */
export function createTestnetKey(path:string,passwordPath:string,key:Hex=generatePrivateKey()):string {
  const signer=account(key);
  if(existsSync(path)||existsSync(passwordPath))throw new Error('KEY_ALREADY_EXISTS');
  const password=randomBytes(32),salt=randomBytes(32),iv=randomBytes(12),derived=scryptSync(password,salt,32);
  const cipher=createCipheriv('aes-256-gcm',derived,iv);
  const ciphertext=Buffer.concat([cipher.update(key,'utf8'),cipher.final()]);
  writeFileSync(passwordPath,password,{mode:0o600,flag:'wx'});
  writeFileSync(path,JSON.stringify({kind:'TESTNET_ONLY_ENCRYPTED_RAW_OBSERVATION_SIGNER',
    salt:salt.toString('hex'),iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),ciphertext:ciphertext.toString('hex')})+'\n',{mode:0o600,flag:'wx'});
  password.fill(0);derived.fill(0);return signer.address;
}
