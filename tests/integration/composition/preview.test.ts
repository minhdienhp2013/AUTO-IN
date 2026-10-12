import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadVerifiedOrderPreview, loadVerifiedOrderPreviewCatalog } from '../../../backend/composition/preview.js';
import type { SqlPool, QueryResult } from '../../../backend/storage/database.js';
import type { Principal } from '../../../backend/core/model.js';

const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const actor:Principal={id:'staff-test',shop_id:'test-shop',role:'staff',verified:true};
const orderId='11111111-1111-4111-8111-111111111111';
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');
test('AI0 serves only current, staff-scoped, hashed raster previews',async()=>{
  const root=await mkdtemp(join(tmpdir(),'autoin-plan-'));
  const dir='doc-verified123456';
  const requestHash='a'.repeat(64);
  let revision=2;
  let manifestHash='';
  const previewRef=dir+'/page-p1.png',manifestRef=dir+'/manifest.json';
  const proof=()=>{
    const item={artifact_ref:manifestRef,manifest_sha256:manifestHash,request_hash:requestHash,
      plan:{artifact_ref:manifestRef,request_hash:requestHash,ready:true},active_revision:revision};
    return item;
  };
  const pool:SqlPool={
    async connect(){throw Error('not needed');},
    async query<T>(sql:string,args?:unknown[]):Promise<QueryResult<T>>{
      assert.ok(sql.includes('ai0_verified_plan_manifests'));
      const rows=args?.[0]==='test-shop'?[proof()]:[];
      return {rows:rows as T[],rowCount:rows.length};
    }
  };
  try {
    await mkdir(join(root,dir),{mode:0o700});
    await writeFile(join(root,previewRef),image);
    const manifest=Buffer.from(JSON.stringify({
      schema:'ai3.document_bridge.v1',request_hash:requestHash,
      previews:[{ref:previewRef,sha256:hash(image),bytes:image.length}]
    }));
    manifestHash=hash(manifest);
    await writeFile(join(root,manifestRef),manifest);
    const bytes=await loadVerifiedOrderPreview(pool,root,actor,orderId,2,0);
    assert.deepEqual(bytes,image);
    const catalog=await loadVerifiedOrderPreviewCatalog(pool,root,actor,orderId,2);
    assert.deepEqual(catalog,{
      order_id:orderId,revision:2,request_hash:requestHash,
      preview_verified:true,preview_count:1,
      previews:[{index:0,url:'/api/v1/orders/'+orderId+'/revisions/2/previews/0',
        content_type:'image/png'}]
    });
    assert.ok(!JSON.stringify(catalog).includes(dir),'Catalog must not expose private artifact refs');
    await assert.rejects(loadVerifiedOrderPreviewCatalog(pool,root,
      {...actor,role:'customer'},orderId,2),{code:'FORBIDDEN'});
    await assert.rejects(loadVerifiedOrderPreviewCatalog(pool,root,
      {...actor,shop_id:'other'},orderId,2),{code:'PREVIEW_NOT_AVAILABLE'});
    await assert.rejects(loadVerifiedOrderPreview(pool,root,{...actor,shop_id:'other'},orderId,2,0),{code:'PREVIEW_NOT_AVAILABLE'});
    await assert.rejects(loadVerifiedOrderPreview(pool,root,{...actor,role:'customer'},orderId,2,0),{code:'FORBIDDEN'});
    await assert.rejects(loadVerifiedOrderPreview(pool,root,actor,orderId,2,1),{code:'PREVIEW_NOT_AVAILABLE'});
    revision=3;
    await assert.rejects(loadVerifiedOrderPreview(pool,root,actor,orderId,2,0),{code:'STALE_OR_UNVERIFIED_PREVIEW'});
    await assert.rejects(loadVerifiedOrderPreviewCatalog(pool,root,actor,orderId,2),{code:'STALE_OR_UNVERIFIED_PREVIEW'});
    revision=2;
    await writeFile(join(root,previewRef),Buffer.from('modified PNG'));
    await assert.rejects(loadVerifiedOrderPreview(pool,root,actor,orderId,2,0),{code:'PREVIEW_BYTES_CHANGED'});
    await assert.rejects(loadVerifiedOrderPreviewCatalog(pool,root,actor,orderId,2),{code:'PREVIEW_BYTES_CHANGED'});
    await writeFile(join(root,manifestRef),Buffer.from('mutated manifest'));
    await assert.rejects(loadVerifiedOrderPreview(pool,root,actor,orderId,2,0),{code:'PREVIEW_MANIFEST_CHANGED'});
    await assert.rejects(loadVerifiedOrderPreviewCatalog(pool,root,actor,orderId,2),{code:'PREVIEW_MANIFEST_CHANGED'});
  } finally {await rm(root,{recursive:true,force:true});}
});
