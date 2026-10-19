import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {canonical} from '../../../backend/core/model.ts';
import {assertIsolatedSimulationDatabase} from '../../../backend/composition/postgres.ts';
const url=process.env.TEST_DATABASE_URL;
test('REAL PostgreSQL: AI3 processor CLI publishes frozen source to AI1 revision',{
  skip:!url?'TEST_DATABASE_URL unset: product processor PG NOT VERIFIED':false
},async()=>{
 assertIsolatedSimulationDatabase(url);
 const root=await mkdtemp(join(tmpdir(),'autoin-integration-'));
 const input=join(root,'input'),artifacts=join(root,'artifacts');
 const pool=new pg.Pool({connectionString:url});
 try{
  await mkdir(input);await mkdir(artifacts);
  const python=process.env.AUTOIN_PYTHON??'python3';
  const file=join(input,'synthetic.png');
  const image=spawnSync(python,['-c','from PIL import Image; import sys; Image.new("RGB",(320,480),"white").save(sys.argv[1])',file]);
  assert.equal(image.status,0,'synthetic image generator');
  const shop=`autoin-test-cli-${randomUUID()}`,order=randomUUID();
  const request={documents:[{artifact_name:'synthetic.png',copies:2,duplex:false,paper:'A4'}]};
  const hash=createHash('sha256').update(canonical(request)).digest('hex');
  await pool.query('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[shop]);
  await pool.query('INSERT INTO core_orders(id,shop_id,customer_id,active_revision) VALUES($1,$2,$3,1)',[order,shop,'synthetic-customer']);
  await pool.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data) VALUES($1,1,$2,$3::jsonb)',[order,hash,JSON.stringify(request)]);
  const output=spawnSync(process.execPath,['--import','tsx','scripts/process-order.ts',shop,order],{
   cwd:process.cwd(),encoding:'utf8',timeout:60000,env:{...process.env,DATABASE_URL:url,
    AUTOIN_INPUT_ROOT:input,AUTOIN_ARTIFACT_ROOT:artifacts,
    AUTOIN_PROCESSOR_ID:'synthetic-processor',AUTOIN_PYTHON:python}});
  assert.equal(output.status,0,'processor CLI must publish without invoking print');
  const receipt=JSON.parse(output.stdout);
  assert.equal(receipt.revision,2);assert.equal(receipt.requires_reconfirmation,true);
  const revision=(await pool.query('SELECT plan FROM core_revisions WHERE order_id=$1 AND revision=2',[order])).rows[0];
  assert.equal(revision.plan.request_hash,hash);
  assert.equal(revision.plan.physical_sheets,2);
  const manifest=JSON.parse(await readFile(join(artifacts,revision.plan.artifact_ref),'utf8'));
  assert.equal(manifest.files.length,1);
  const source=join(artifacts,manifest.files[0].source_artifact_ref);
  const before=await readFile(source);
  await writeFile(file,'replaced after plan');
  assert.deepEqual(await readFile(source),before,'approved artifact must not depend on mutable inbound');
 }finally{await pool.end();await rm(root,{recursive:true,force:true});}
});
