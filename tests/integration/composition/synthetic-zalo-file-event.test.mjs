import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSyntheticZaloFileEvent } from '../../../backend/composition/synthetic-zalo-file-event.ts';

function event(msgId, name = 'reference.pdf') {
  return {
    app_id: 'synthetic-app',
    sender: { id: 'synthetic-sender' },
    recipient: { id: 'synthetic-recipient' },
    message: {
      msg_id: msgId,
      attachments: [{
        type: 'file',
        payload: {
          size: 1234,
          name,
          checksum: 'a'.repeat(32),
          type: 'application/pdf',
          url: 'https://media.invalid/synthetic/reference.pdf'
        }
      }]
    },
    timestamp: 1_761_000_000_000
  };
}

test('synthetic file-event DTO preserves documented fields and remains held', () => {
  const parsed = parseSyntheticZaloFileEvent(event('synthetic-msg-1'));
  assert.deepEqual(parsed, {
    source: 'SYNTHETIC_UNVERIFIED',
    hold_state: 'HELD_FOR_REVIEW',
    review_state: 'AWAITING_REVIEW',
    media_state: 'AWAITING_MEDIA',
    app_id: 'synthetic-app',
    sender_id: 'synthetic-sender',
    recipient_id: 'synthetic-recipient',
    provider_message_id_hint: 'synthetic-msg-1',
    timestamp: 1_761_000_000_000,
    attachments: [{
      attachment_type: 'file',
      size: 1234,
      name: 'reference.pdf',
      checksum: 'a'.repeat(32),
      type: 'application/pdf',
      url: 'https://media.invalid/synthetic/reference.pdf'
    }]
  });
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.attachments), true);
  assert.equal(Object.isFrozen(parsed.attachments[0]), true);
});

test('multiple attachments preserve order and stay unselected', () => {
  const input = event('synthetic-msg-2');
  input.message.attachments.push({
    type: 'file',
    payload: {
      size: '42', name: 'second.png', checksum: 'b'.repeat(32), type: 'image/png',
      url: 'https://media.invalid/synthetic/second.png'
    }
  });
  const parsed = parseSyntheticZaloFileEvent(input);
  assert.deepEqual(parsed.attachments.map(item => item.name), ['reference.pdf', 'second.png']);
  assert.equal(parsed.attachments[1].size, '42');
  assert.equal('selected_attachment' in parsed, false);
  assert.equal('order_id' in parsed, false);
  assert.equal('source_ref' in parsed, false);
});

test('same provider message hint does not merge separate events or attach an order', () => {
  const first = parseSyntheticZaloFileEvent(event('reused-msg-id', 'first.pdf'));
  const second = parseSyntheticZaloFileEvent(event('reused-msg-id', 'second.pdf'));
  assert.notEqual(first, second);
  assert.equal(first.provider_message_id_hint, second.provider_message_id_hint);
  assert.equal(first.attachments[0].name, 'first.pdf');
  assert.equal(second.attachments[0].name, 'second.pdf');
  assert.equal('order_id' in first, false);
  assert.equal('order_id' in second, false);
});

test('malformed synthetic events fail closed', () => {
  for (const input of [
    null,
    {},
    { ...event('msg'), message: { msg_id: 'msg', attachments: [] } },
    { ...event('msg'), timestamp: -1 },
    { ...event('msg'), message: { ...event('msg').message, attachments: [{ type: 'file', payload: { ...event('msg').message.attachments[0].payload, url: '' } }] } }
  ]) assert.throws(() => parseSyntheticZaloFileEvent(input));
});

test('parsing does not use global fetch', () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('must not fetch'); };
  try {
    parseSyntheticZaloFileEvent(event('synthetic-msg-3'));
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});
