import pg from 'pg';
import {lstat,readFile} from 'node:fs/promises';
import path from 'node:path';
import {asSqlPool} from '../backend/composition/postgres.js';
import {DomainError} from '../backend/core/model.js';
import {PgStore} from '../backend/storage/database.js';
import {issueControlledTestGrant,revokeControlledTestGrant} from '../backend/core/controlled-test-grant.js';

function exactKeys(value:Record<string,unknown>,keys:string[]):boolean{
 return Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
}
async function requestFile(filePath:string):Promise<Record<string,unknown>>{
 const absolute=path.resolve(filePath);
 const info=await lstat(absolute);
 if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||info.size<1||info.size>4096)
  throw new DomainError('CONTROLLED_TEST_REQUEST_FILE_INVALID','Request file must be a private regular file',422);
 let value:unknown;
 try{value=JSON.parse(await readFile(absolute,'utf8'));}
 catch{throw new DomainError('CONTROLLED_TEST_REQUEST_FILE_INVALID','Request file is invalid JSON',422);}
 if(!value||typeof value!=='object'||Array.isArray(value))
  throw new DomainError('CONTROLLED_TEST_REQUEST_FILE_INVALID','Request must be a JSON object',422);
 return value as Record<string,unknown>;
}
async function main():Promise<void>{
 const args=process.argv.slice(2);
 if(args.length!==1||!process.env.DATABASE_URL||!process.env.AUTOIN_CONTROLLED_TEST_OPERATOR_ROLE)
  throw new DomainError('CONTROLLED_TEST_OPERATOR_CONFIGURATION_REQUIRED',
   'Supply one private request file and configured operator DB role',503);
 const request=await requestFile(args[0]!);
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,max:1});
 try{
  const store=new PgStore(asSqlPool(pool));
  if(request.action==='grant'&&exactKeys(request,
    ['action','shop_id','order_id','printer_id','owner_id','ttl_seconds','ticket_ref'])){
   if(typeof request.shop_id!=='string'||typeof request.order_id!=='string'||
      typeof request.printer_id!=='string'||typeof request.owner_id!=='string'||
      typeof request.ttl_seconds!=='number'||typeof request.ticket_ref!=='string')
    throw new DomainError('CONTROLLED_TEST_GRANT_INPUT_INVALID','Grant request fields have wrong types',422);
   const result=await issueControlledTestGrant(store,{shop_id:request.shop_id,order_id:request.order_id,
    printer_id:request.printer_id,owner_id:request.owner_id,ttl_seconds:request.ttl_seconds,
    ticket_ref:request.ticket_ref},process.env.AUTOIN_CONTROLLED_TEST_OPERATOR_ROLE);
   console.info(`CONTROLLED_TEST_GRANT_ISSUED expires_at=${result.expires_at}`);
   return;
  }
  if(request.action==='revoke'&&exactKeys(request,
    ['action','shop_id','order_id','printer_id','ticket_ref'])){
   if(typeof request.shop_id!=='string'||typeof request.order_id!=='string'||
      typeof request.printer_id!=='string'||typeof request.ticket_ref!=='string')
    throw new DomainError('CONTROLLED_TEST_GRANT_INPUT_INVALID','Revoke request fields have wrong types',422);
   await revokeControlledTestGrant(store,{shop_id:request.shop_id,order_id:request.order_id,
    printer_id:request.printer_id,ticket_ref:request.ticket_ref},process.env.AUTOIN_CONTROLLED_TEST_OPERATOR_ROLE);
   console.info('CONTROLLED_TEST_GRANT_REVOKED');
   return;
  }
  throw new DomainError('CONTROLLED_TEST_GRANT_INPUT_INVALID','Unsupported or non-exact operator request',422);
 }finally{await pool.end();}
}
main().catch(error=>{
 console.error(error instanceof DomainError?error.code:'CONTROLLED_TEST_COMMAND_FAILED');
 process.exitCode=1;
});
