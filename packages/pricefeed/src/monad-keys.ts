import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, parse, resolve, sep } from 'node:path';
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
  path=privatePath(path);
  let fd:number;
  try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);}catch{throw new Error('PRIVATE_FILE_REQUIRED');}
  try{
    const stat=fstatSync(fd);
    if(!stat.isFile()||(stat.mode&0o077)!==0||stat.nlink!==1||stat.size>limit||stat.uid!==process.getuid?.())throw new Error('PRIVATE_FILE_REQUIRED');
    return readFileSync(fd);
  }finally{closeSync(fd);}
}
/** Normalize once, reject symlink ancestors, and require an owner-only immediate parent. */
function privatePath(path:string):string {
  const target=resolve(path),parent=dirname(target),root=parse(parent).root;let cursor=root;
  try{
    for(const segment of parent.slice(root.length).split(sep).filter(Boolean)){
      cursor=resolve(cursor,segment);const stat=lstatSync(cursor);
      if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error();
    }
    const stat=lstatSync(parent);
    if((stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw new Error();
  }catch{throw new Error('PRIVATE_DIRECTORY_REQUIRED');}
  return target;
}
/** Existing journal/WAL/SHM files must be real, single-link and owned by this user.
 * The owner-only parent protects legacy DB modes; no existing file is chmodded.
 */
export function testnetJournalPath(path:string,create:boolean):string {
  path=privatePath(path);
  let mainMissing=false;
  for(const target of [path,path+'-wal',path+'-shm']){
    let stat;
    try{stat=lstatSync(target);}catch(error){
      if(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT'){
        if(target===path){if(!create)throw new Error('TESTNET_JOURNAL_MISSING');mainMissing=true;}continue;
      }
      throw new Error('TESTNET_PRIVATE_FILE_REQUIRED');
    }
    if(mainMissing&&target!==path)throw new Error('TESTNET_JOURNAL_ORPHANED_SIDECAR');
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid?.())throw new Error('TESTNET_PRIVATE_FILE_REQUIRED');
  }
  return path;
}
/** Testnet-only encrypted key custody. Paths/passwords/key values are never in errors. */
export function loadTestnetKey(path:string,passwordPath:string,expectedAddress:string):PrivateKeyAccount {
  const encrypted=privateFile(path,4096),password=privateFile(passwordPath,32);
  let plaintext:Buffer|undefined,derived:Buffer|undefined;let key:string;
  try{
    const saved=JSON.parse(encrypted.toString('utf8'));
    if(saved.kind!=='TESTNET_ONLY_ENCRYPTED_RAW_OBSERVATION_SIGNER'||password.length!==32
      ||!/^([a-f0-9]{2}){32}$/.test(saved.salt)||!/^([a-f0-9]{2}){12}$/.test(saved.iv)
      ||!/^([a-f0-9]{2}){16}$/.test(saved.tag)||!/^([a-f0-9]{2}){66}$/.test(saved.ciphertext))throw new Error();
    derived=scryptSync(password,Buffer.from(saved.salt,'hex'),32);
    const decipher=createDecipheriv('aes-256-gcm',derived,Buffer.from(saved.iv,'hex'));
    decipher.setAuthTag(Buffer.from(saved.tag,'hex'));
    plaintext=Buffer.concat([decipher.update(Buffer.from(saved.ciphertext,'hex')),decipher.final()]);key=plaintext.toString('utf8');
  }catch{throw new Error('KEY_UNLOCK_FAILED');}finally{password.fill(0);derived?.fill(0);plaintext?.fill(0);}
  const result=account(key);
  if(result.address.toLowerCase()!==expectedAddress.toLowerCase())throw new Error('KEY_IDENTITY_MISMATCH');
  return result;
}
/** Explicit setup helper; caller supplies a private directory. Never overwrites custody. */
export function createTestnetKey(path:string,passwordPath:string,key:Hex=generatePrivateKey()):string {
  const signer=account(key);
  path=privatePath(path);passwordPath=privatePath(passwordPath);
  if(path===passwordPath)throw new Error('KEY_PATHS_MUST_DIFFER');
  if(existsSync(path)||existsSync(passwordPath))throw new Error('KEY_ALREADY_EXISTS');
  const password=randomBytes(32),salt=randomBytes(32),iv=randomBytes(12);let derived:Buffer|undefined;
  const created:{path:string;dev:number;ino:number}[]=[];
  const write=(target:string,value:string|Buffer)=>{
    const fd=openSync(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{const stat=fstatSync(fd);created.push({path:target,dev:stat.dev,ino:stat.ino});writeFileSync(fd,value);fsyncSync(fd);}
    finally{closeSync(fd);}
  };
  try{
    derived=scryptSync(password,salt,32);
    const cipher=createCipheriv('aes-256-gcm',derived,iv),ciphertext=Buffer.concat([cipher.update(key,'utf8'),cipher.final()]);
    write(passwordPath,password);
    write(path,JSON.stringify({kind:'TESTNET_ONLY_ENCRYPTED_RAW_OBSERVATION_SIGNER',
      salt:salt.toString('hex'),iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),ciphertext:ciphertext.toString('hex')})+'\n');
    for(const parent of new Set(created.map(f=>dirname(f.path)))){
      const fd=openSync(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}
    }
    return signer.address;
  }catch{
    // Remove only files created by this attempt, never an existing or replaced file.
    for(const file of created){try{const stat=lstatSync(file.path);if(stat.dev===file.dev&&stat.ino===file.ino)unlinkSync(file.path);}catch{/* Preserve uncertain files for review. */}}
    throw new Error('KEY_CREATE_FAILED');
  }finally{password.fill(0);derived?.fill(0);}
}
