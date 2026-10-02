import { readFileSync } from 'node:fs';
import { OBSERVATION_FIELDS, OBSERVATION_TYPE } from '../src/wire.js';

const root=new URL('../../../../',import.meta.url);
const iface=readFileSync(new URL('contracts/src/interfaces/IPriceSource.sol',root),'utf8');
const source=readFileSync(new URL('contracts/src/pricing/PriceIngress.sol',root),'utf8');
const body=iface.match(/struct Observation\s*\{([\s\S]*?)\}/)?.[1];
if(!body)throw new Error('MISSING_RISK_OBSERVATION_STRUCT');
const fields=[...body.matchAll(/\b(bytes32|uint64|uint256)\s+(\w+)\s*;/g)].map(m=>[m[2],m[1]]);
if(JSON.stringify(fields)!==JSON.stringify(OBSERVATION_FIELDS))throw new Error('RISK_OBSERVATION_ABI_DRIFT');
const type=source.match(/OBSERVATION_TYPEHASH\s*=\s*keccak256\(\s*"([^"]+)"/)?.[1];
if(type!==OBSERVATION_TYPE)throw new Error('RAW_DIGEST_TYPE_STRING_DRIFT');
const start=source.indexOf('abi.encode(',source.indexOf('function _digest'));
let depth=1,end=start+'abi.encode('.length;
while(start>=0&&end<source.length&&depth>0){if(source[end]==='(')depth++;if(source[end]===')')depth--;end++;}
if(start<0||depth!==0)throw new Error('MISSING_RAW_DIGEST_ENCODING');
const encoding=source.slice(start+'abi.encode('.length,end-1).replace(/\s+/g,'');
const expected=['OBSERVATION_TYPEHASH',...OBSERVATION_FIELDS.map(([name])=>`o.${name}`),'block.chainid','address(this)'].join(',');
if(encoding!==expected)throw new Error('RAW_DIGEST_FIELD_ORDER_DRIFT');
console.log('PASS: exact eleven-field ABI, type string and raw abi.encode order match existing risk code (read-only)');
