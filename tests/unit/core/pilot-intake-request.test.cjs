const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../dist/backend');
const {pilotRevisionSourceBinding}=require(path.join(root,'core/pilot-intake-request.js'));
const {pilotSettingsHash}=require(path.join(root,'core/pilot-shop-code.js'));

const sha='a'.repeat(64);
const settings={copies:2,duplex:true,paper:'A4',color:'black_white'};
const request={documents:[{artifact_name:`doc-${'1'.repeat(32)}/source-000-${sha}.pdf`,copies:2,duplex:true,paper:'A4'}],
 sealed_source:{format:'PDF',sha256:sha,size_bytes:123,provider_event_id:'source-event'},
 pilot_settings:settings,pilot_settings_sha256:pilotSettingsHash(settings),settings_event_ids:['settings-event']};

test('Core accepts exact sealed PDF/DOCX revision metadata and validates the source ref against format/hash',()=>{
 const pdf=pilotRevisionSourceBinding(request);
 assert.equal(pdf.format,'PDF');assert.equal(pdf.artifact_ref,request.documents[0].artifact_name);
 assert.equal(pdf.sha256,sha);assert.equal(pdf.size_bytes,123);
 const docx={...request,documents:[{...request.documents[0],artifact_name:`doc-${'2'.repeat(32)}/source-000-${sha}.docx`}],
  sealed_source:{...request.sealed_source,format:'DOCX'}};
 assert.equal(pilotRevisionSourceBinding(docx).format,'DOCX');
});

test('Core fails closed on caller metadata drift, invalid settings, or unbound settings events',()=>{
 for(const bad of [
  {...request,sealed_source:{...request.sealed_source,sha256:'b'.repeat(64)}},
  {...request,sealed_source:{...request.sealed_source,format:'DOCX'}},
  {...request,pilot_settings:{...settings,copies:0}},
  {...request,pilot_settings_sha256:'c'.repeat(64)},
  {...request,settings_event_ids:[]},
  {...request,artifact_name:'https://caller.invalid/source.pdf'},
  {...request,unexpected:'caller-supplied-path'}
 ])assert.throws(()=>pilotRevisionSourceBinding(bad));
});

test('legacy source review request keeps its unchanged documents-only shape',()=>{
 assert.equal(pilotRevisionSourceBinding({documents:[{artifact_name:'bundle/source.pdf'}]}),null);
});
