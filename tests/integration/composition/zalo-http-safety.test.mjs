import test from 'node:test';
import assert from 'node:assert/strict';
import { createZaloRawWebhook } from '../../../backend/composition/zalo-http.ts';

test('Zalo HTTP plugin configures raw JSON parsing and forwards exact bytes/signature', async () => {
  const body = '{\n  "app_id": "demo-app",\n  "user_id_by_app": "demo-user",\n  "message": { "text": "Xin chào" }\n}';
  const expectedBytes = Buffer.from(body, 'utf8');
  let contentTypeParser;
  let routePath;
  let routeHandler;
  const app = {
    addContentTypeParser(type, options, parser) {
      assert.equal(type, 'application/json');
      assert.equal(options.parseAs, 'buffer');
      contentTypeParser = parser;
    },
    post(path, handler) {
      routePath = path;
      routeHandler = handler;
    }
  };
  let received;

  await createZaloRawWebhook({
    async receive_webhook(raw, headers) {
      received = { raw: Buffer.from(raw), headers };
      return { status_code: 202, body: { accepted: true } };
    }
  })(app);

  assert.equal(routePath, '/webhooks/zalo');
  assert.equal(typeof routeHandler, 'function');
  const parsedBody = await new Promise((resolve, reject) => {
    contentTypeParser({}, expectedBytes, (error, value) => error ? reject(error) : resolve(value));
  });
  assert.deepEqual(parsedBody, expectedBytes);

  const replyState = { status: 200, body: undefined };
  const reply = {
    code(status) { replyState.status = status; return this; },
    send(value) { replyState.body = value; return this; }
  };
  await routeHandler({
    body: parsedBody,
    headers: { 'x-zevent-signature': 'mac=' + 'a'.repeat(64) }
  }, reply);

  assert.equal(replyState.status, 202);
  assert.deepEqual(replyState.body, { accepted: true });
  assert.deepEqual(received?.raw, expectedBytes);
  assert.equal(received?.headers['x-zevent-signature'], 'mac=' + 'a'.repeat(64));
});
