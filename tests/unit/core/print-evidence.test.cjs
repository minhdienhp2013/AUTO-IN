const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {checkedEvidence}=require(path.join(root,'core/print-evidence.js'));
const {canonical,sha}=require(path.join(root,'core/model.js'));
const scope={shop_id:'shop',order_id:'order',revision:2,request_hash:sha('request'),
 plan:{request_hash:sha('request'),physical_sheets:1,document_pages:1,printed_faces:1,ready:true,
 printer_id:'RMP7000',artifact_ref:'source.pdf',verified_by:'processor'}};
const proof=()=>{
 const sources=[{source_artifact_ref:'source.pdf',format:'pdf',size_bytes:12,source_sha256:sha('source-bytes')}];
 const data={schema:'ai0.print_evidence.v1',shop_id:scope.shop_id,order_id:scope.order_id,
 revision:scope.revision,request_hash:scope.request_hash,sources,source_set_sha256:sha(canonical(sources)),
 settings_sha256:sha('settings'),manifest_ref:'manifest.json',manifest_sha256:sha('manifest'),
 previews:[{index:0,bytes:1024,sha256:sha('preview')}],renderer_sha256:sha('renderer'),
 plan_sha256:sha(canonical(scope.plan)),printer_id:'RMP7000',printer_capability_sha256:sha('queue')};
 return {...data,evidence_sha256:sha(canonical(data))};
};
const stale=p=>assert.throws(()=>checkedEvidence(scope,p),e=>e.code==='STALE_PRINT_EVIDENCE');
test('PR150 evidence tuple recomputes canonical digest and binds source-set order',()=>{
 const base=proof();assert.equal(checkedEvidence(scope,base),base.evidence_sha256);
 stale({...base,manifest_sha256:sha('changed')});stale({...base,settings_sha256:sha('changed')});
 stale({...base,previews:[{index:0,bytes:1024,sha256:sha('changed')}]});
 stale({...base,sources:[{...base.sources[0],source_sha256:sha('changed')}]});
 stale({...base,shop_id:'different'});stale({...base,revision:3});
 stale({...base,plan_sha256:sha('changed')});stale({...base,printer_capability_sha256:sha('changed')});
 stale({...base,evidence_sha256:'client-proof'});
});
