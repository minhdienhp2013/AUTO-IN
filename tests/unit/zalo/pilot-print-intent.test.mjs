import test from 'node:test';
import assert from 'node:assert/strict';
import {extractPilotPrintIntent} from '../../../backend/conversation/pilot-print-intent.ts';

const event=(event_id,kind,text)=>({event_id,oa_id:'oa-synthetic',customer_id:'customer-synthetic',
  conversation_id:'conversation-synthetic',occurred_at:'2026-10-21T03:00:00.000Z',kind,...(text?{text}:{})});

test('complete settings and one exact Crockford code produce candidates only',()=>{
  const intent=extractPilotPrintIntent([
    event('settings-1','text','In 2 bản, A4, 2 mặt, đen trắng.'),
    event('code-1','text','Mã cửa hàng: ABCDEFGHJK')
  ]);
  assert.equal(intent?.status,'ready_for_core_validation');
  assert.equal(intent?.code_candidate,'ABCDEFGHJK');
  assert.equal(intent?.code_event_id,'code-1');
  assert.equal(intent?.copies,2);
  assert.equal(intent?.paper,'A4');
  assert.equal(intent?.sides,2);
  assert.equal(intent?.black_white,true);
  assert.equal('approved' in intent,false);
  assert.equal('job_id' in intent,false);
});

test('code candidate rejects non-Crockford, wrong-length, and unlabelled values',()=>{
  for(const code of ['ABCDEFGHIJ','ABCDEFGHJ','ABCDEFGHIJK','123456789O','12345-6789']){
    const intent=extractPilotPrintIntent([event('all-1','text',
      `Mã: ${code}; In 1 bản A4 một mặt đen trắng`)]);
    assert.equal(intent?.status,'needs_clarification',code);
    assert.equal(intent?.code_candidate,null,code);
    assert.ok(intent?.reasons.includes('INVALID_CODE_FORMAT'),code);
  }
  const bare=extractPilotPrintIntent([event('bare-1','text',
    '0123456789 In 1 bản A4 một mặt đen trắng')]);
  assert.equal(bare?.reasons.includes('MISSING_CODE'),true);
});

test('same code repeated across events is ambiguous; setting conflicts hold',()=>{
  const duplicated=extractPilotPrintIntent([
    event('code-1','text','Mã: 0123456789'),event('code-2','text','Mã: 0123456789'),
    event('settings-1','text','In 1 bản A4 một mặt đen trắng')
  ]);
  assert.equal(duplicated?.code_candidate,null);
  assert.ok(duplicated?.reasons.includes('CONFLICTING_CODE'));
  const conflicting=extractPilotPrintIntent([
    event('one','text','Mã: 0123456789; In 1 bản A4 một mặt đen trắng'),
    event('two','text','Mã: ABCDEFGHJK; 2 bản; hai mặt')
  ]);
  assert.equal(conflicting?.status,'needs_clarification');
  assert.ok(conflicting?.reasons.includes('CONFLICTING_CODE'));
  assert.ok(conflicting?.reasons.includes('CONFLICTING_COPIES'));
  assert.ok(conflicting?.reasons.includes('CONFLICTING_SIDES'));
});

test('positive color mention is explicit human intent; a negated mention is not mislabeled as a color choice',()=>{
  const selected=extractPilotPrintIntent([event('color-selected','text','Mình chọn màu, A4, 2 bản, hai mặt')]);
  assert.equal(selected?.color_requested,true);
  assert.equal(selected?.black_white,false);
  const declined=extractPilotPrintIntent([event('color-declined','text','Không in màu, đen trắng, A4, 2 bản, hai mặt')]);
  assert.equal(declined?.color_requested,false);
});

test('unsupported print options and mixed persisted identities never become ready',()=>{
  for(const text of [
    'Mã: 0123456789; In 0 bản A4 một mặt đen trắng',
    'Mã: 0123456789; In 2 bản A3 một mặt đen trắng',
    'Mã: 0123456789; In 2 bản A4 một mặt in màu',
    'Mã: 0123456789; In 2 bản A4 đen trắng'
  ])assert.equal(extractPilotPrintIntent([event('one','text',text)])?.status,'needs_clarification');
  assert.equal(extractPilotPrintIntent([
    event('one','text','Mã: 0123456789'),
    {...event('two','text','In 1 bản A4 một mặt đen trắng'),customer_id:'other'}
  ]),null);
  assert.equal(extractPilotPrintIntent([
    event('one','text','Mã: 0123456789'),event('one','text','In 1 bản A4 một mặt đen trắng')
  ]),null);
});
