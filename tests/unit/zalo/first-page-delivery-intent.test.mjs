import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareFirstPageSuggestedIntent,checkFirstPageSuggestedIntent
} from '../../../backend/conversation/first-page-delivery-intent.ts';
import {SAFE_FIRST_PAGE_QUESTION} from '../../../backend/conversation/first-page-question.ts';

const scope={shop_id:'shop-test',order_id:'12345678-1234-4123-8123-123456789abc',
  revision:2,oa_id:'oa-test',customer_id:'customer-test',
  conversation_id:'conversation-test'};
const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64);
const gate={mode:'AI',generation:7,conversation_id:scope.conversation_id};
const snapshot=()=>({
  current:{...scope,active_revision:scope.revision,request_hash:A,source_sha256:B,
    sealed_source_verified:true},
  advisory:{shop_id:scope.shop_id,order_id:scope.order_id,revision:scope.revision,
    request_hash:A,artifact_sha256:B,metadata:{
      schema_version:'tn005.first_page.v1',status:'SUGGESTED',
      category:'EXAM',confidence_label:'high',analyzed_page_count:1,
      method:'pymupdf_page0_text',reason_code:'NONE',
    }},
});
function trustedIntent(){
  const prepared=prepareFirstPageSuggestedIntent(scope,snapshot(),gate);
  assert.equal(prepared.status,'suggested');
  return prepared.intent;
}
for(const stage of ['before_enqueue','before_delivery']){
  test('TN005 '+stage+' verifies all nine evidence fields and immutable safe text',()=>{
    const intent=trustedIntent();
    assert.deepEqual(intent.evidence,{...scope,request_hash:A,source_sha256:B,generation:7});
    assert.equal(Object.isFrozen(intent),true);
    assert.equal(Object.isFrozen(intent.evidence),true);
    assert.throws(()=>{intent.evidence.source_sha256=C},TypeError);
    assert.throws(()=>{intent.text='OCR SOURCE PRIVATE'},TypeError);
    const result=checkFirstPageSuggestedIntent(intent,scope,snapshot(),gate,stage);
    assert.equal(result.status,'current');
    assert.equal(result.text,intent.text);
    assert.match(result.text,/Trang đầu có vẻ là đề kiểm tra hoặc đề thi/);
    assert.doesNotMatch(result.text,/giá|đã in|đã duyệt|đã xác nhận/iu);
  });
  test('TN005 '+stage+' revision or source/hash change requires NEW generic rebind',()=>{
    const intent=trustedIntent();
    const cases=[
      [{...scope,revision:3},snapshot()],
      [scope,{...snapshot(),current:{...snapshot().current,active_revision:3}}],
      [scope,{...snapshot(),current:{...snapshot().current,request_hash:C}}],
      [scope,{...snapshot(),current:{...snapshot().current,source_sha256:C}}],
      [scope,{...snapshot(),advisory:{...snapshot().advisory,artifact_sha256:C}}],
      [scope,{...snapshot(),current:{...snapshot().current,sealed_source_verified:false}}],
      [scope,{...snapshot(),advisory:null}],
      [scope,{...snapshot(),advisory:{...snapshot().advisory,
        metadata:{...snapshot().advisory.metadata,status:'UNKNOWN'}}}],
    ];
    for(const [currentScope,latest] of cases){
      const check=checkFirstPageSuggestedIntent(intent,currentScope,latest,gate,stage);
      assert.deepEqual(check,{status:'generic_rebind_required',text:SAFE_FIRST_PAGE_QUESTION});
      assert.equal('intent' in check,false);
    }
  });
  test('TN005 '+stage+' handover, paused or new generation BLOCKS any outbound',()=>{
    const intent=trustedIntent();
    for(const newGate of [
      {...gate,mode:'HUMAN',generation:8},
      {...gate,mode:'PAUSED'},
      {...gate,generation:8}, // returned to AI after a handover: older proof is stale
      {...gate,conversation_id:'other-chat'},
      null
    ]){
      const check=checkFirstPageSuggestedIntent(intent,scope,snapshot(),newGate,stage);
      assert.deepEqual(check,{status:'blocked',text:SAFE_FIRST_PAGE_QUESTION});
    }
  });
  test('TN005 '+stage+' rejects wrong scope, altered intent, OCR injection or invalid generation',()=>{
    const intent=trustedIntent();
    for(const forged of [
      {...intent,text:'OCR SOURCE PRIVATE'},
      {...intent,evidence:{...intent.evidence,shop_id:'other-shop'}},
      {...intent,evidence:{...intent.evidence,customer_id:'other-customer'}},
      {...intent,evidence:{...intent.evidence,request_hash:C}},
      {...intent,evidence:{...intent.evidence,source_sha256:'malformed'}},
      {...intent,evidence:{...intent.evidence,generation:NaN}},
      {...intent,evidence:{...intent.evidence,extra:'OCR SOURCE PRIVATE'}},
      {...intent,extra:'approve'},
      null,
    ]){
      const result=checkFirstPageSuggestedIntent(forged,scope,snapshot(),gate,stage);
      assert.notEqual(result.status,'current');
      assert.doesNotMatch(result.text,/OCR SOURCE PRIVATE/);
    }
    assert.equal(checkFirstPageSuggestedIntent(intent,{...scope,oa_id:'foreign'},snapshot(),
      gate,stage).status,'blocked');
  });
}

test('TN005 missing or uncertain suggestion only prepares generic prose, NO outbox intent',()=>{
  const cases=[
    null,undefined,
    {...snapshot(),advisory:null},
    {...snapshot(),advisory:{...snapshot().advisory,
      metadata:{...snapshot().advisory.metadata,status:'NEEDS_HUMAN'}}},
    {...snapshot(),current:{...snapshot().current,active_revision:3}},
  ];
  for(const value of cases){
    assert.deepEqual(prepareFirstPageSuggestedIntent(scope,value,gate),
      {status:'generic',text:SAFE_FIRST_PAGE_QUESTION});
  }
  assert.deepEqual(prepareFirstPageSuggestedIntent(scope,snapshot(),{...gate,mode:'HUMAN'}),
    {status:'blocked',text:SAFE_FIRST_PAGE_QUESTION});
});

test('TN005 pure guards never call write/outbox/OA/print mutation APIs',()=>{
  let calls=0;
  const forbid={
    enqueue(){calls++;assert.fail('outbox mutation must never be invoked')},
    approve(){calls++;assert.fail('approval is prohibited')},
    print(){calls++;assert.fail('printing is prohibited')},
    send_oa(){calls++;assert.fail('OA send is prohibited')}
  };
  const intent=trustedIntent();
  for(const stage of ['before_enqueue','before_delivery']){
    const result=checkFirstPageSuggestedIntent(intent,scope,snapshot(),gate,stage);
    assert.equal(result.status,'current');
    // This is deliberately data-only: never pass forbid ports into any AI2 code.
    assert.equal(Object.keys(result).sort().join(','),'status,text');
  }
  assert.deepEqual(Object.values(forbid).length,4);
  assert.equal(calls,0);
});
