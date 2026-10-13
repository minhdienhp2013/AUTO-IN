import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ingestSyntheticArtifact } from '../../../backend/composition/synthetic-ingest.js';
import type { SqlPool, QueryResult } from '../../../backend/storage/database.js';
import type { Principal } from '../../../backend/core/model.js';

const actor: Principal = {id:'staff-1',shop_id:'synthetic-shop',role:'staff',verified:true};
const scope = {shop_id:'synthetic-shop',oa_id:'fixture-oa'};
const bytes = Buffer.from('fixture only - never ready for print');
const request = {
  event_id:'signed-event-1',
  filename:'sample.pdf',
  content_base64:bytes.toString('base64')
};
function fakeDb() {
  let saved: {artifact_ref:string;sha256:string;manifest_ref:string;manifest_sha256:string}|null=null;
  let inserts=0;
  const pool: SqlPool = {
    async connect() { throw new Error('No connection needed'); },
    async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      let rows: unknown[] = [];
      if (sql.startsWith('SELECT mode')) rows = [{mode:'simulation'}];
      else if (sql.startsWith('SELECT payload_json')) rows = [{
        customer_id:'customer-1',conversation_id:'conversation-1',
        payload_json:{kind:'file',filename:'sample.pdf',
          customer_id:'customer-1',conversation_id:'conversation-1'}
      }];
      else if (sql.startsWith('SELECT artifact_ref')) rows = saved ? [saved] : [];
      else if (sql.startsWith('INSERT INTO ai0_inbound_document_artifacts')) {
        inserts++;
        if (saved) return {rows:[],rowCount:0};
        saved = {artifact_ref:String(params?.[3]),sha256:String(params?.[4]),
          manifest_ref:String(params?.[5]),manifest_sha256:String(params?.[6])};
        rows=[{artifact_ref:saved.artifact_ref}];
      } else throw new Error('Unexpected SQL: '+sql);
      return {rows:rows as T[],rowCount:rows.length};
    }
  };
  return {pool, getSaved:()=>saved, getInserts:()=>inserts};
}
test('AI0 synthetic file ingestion freezes digest-bound AI3 manifest and is idempotent',async()=>{
  const root=await mkdtemp(join(tmpdir(),'autoin-artifacts-'));
  try {
    const db=fakeDb();
    const first=await ingestSyntheticArtifact(db.pool,root,scope,actor,request);
    assert.equal(first.status,'registered');
    assert.equal(first.kind,'synthetic_fixture');
    assert.equal(first.preview_trusted,false);
    assert.equal(first.sha256,createHash('sha256').update(bytes).digest('hex'));
    const proof=db.getSaved();
    assert.ok(proof);
    const source=await readFile(join(root,proof.artifact_ref));
    assert.deepEqual(source,bytes);
    const manifestBytes=await readFile(join(root,proof.manifest_ref));
    assert.equal(proof.manifest_sha256,createHash('sha256').update(manifestBytes).digest('hex'));
    const manifest=JSON.parse(manifestBytes.toString('utf8'));
    assert.equal(manifest.schema,'ai3.upload_snapshot.v1');
    assert.equal(manifest.files[0].source_artifact_ref,proof.artifact_ref);
    assert.equal(manifest.files[0].file_sha256,first.sha256);
    assert.equal(manifest.files[0].size_bytes,bytes.length);
    const second=await ingestSyntheticArtifact(db.pool,root,scope,actor,request);
    assert.equal(second.status,'existing');
    assert.equal(db.getInserts(),1);
    assert.equal((await readdir(root)).length,1);
    await assert.rejects(ingestSyntheticArtifact(db.pool,root,scope,actor,{
      ...request,content_base64:Buffer.from('different content').toString('base64')
    }),{code:'ARTIFACT_IMMUTABLE'});
  } finally {await rm(root,{recursive:true,force:true});}
});
test('AI0 synthetic import rejects nonstaff, other shops, traversal, malformed bytes and event mismatch',async()=>{
  const root=await mkdtemp(join(tmpdir(),'autoin-artifacts-'));
  try {
    const db=fakeDb();
    await assert.rejects(ingestSyntheticArtifact(db.pool,root,scope,
      {id:'agent',shop_id:scope.shop_id,role:'print_agent',verified:true},request),{code:'FORBIDDEN'});
    await assert.rejects(ingestSyntheticArtifact(db.pool,root,scope,
      {...actor,shop_id:'other-shop'},request),{code:'FORBIDDEN'});
    for(const invalid of [
      {...request,filename:'../evil.pdf'},
      {...request,filename:'sample.exe'},
      {...request,content_base64:'!!'},
      {...request,filename:'changed.pdf'},
    ]) await assert.rejects(ingestSyntheticArtifact(db.pool,root,scope,actor,invalid));
    assert.equal((await readdir(root)).length,0);
  } finally {await rm(root,{recursive:true,force:true});}
});
