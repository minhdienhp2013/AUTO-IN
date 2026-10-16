import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemas } from './schemas.js';
import { routes } from './routes.js';
const schemaDoc = { $schema: 'http://json-schema.org/draft-07/schema#', $id: 'https://auto-in.invalid/contracts/v0.1/schema.json',
  title: 'AUTO-IN wire v0.1', definitions: schemas };
const errors = Object.fromEntries([401, 403, 409, 422, 503, 500].map(code => [code, {
  description: `HTTP ${code}`, content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
}]));
const paths: Record<string, Record<string, unknown>> = {};
for (const route of routes) {
  const parameters: Array<{ name: string; in: string; required: boolean; schema: unknown }> = [...route.path.matchAll(/\{([^}]+)\}/g)].map(match => ({ name: match[1]!, in: 'path', required: true, schema: schemas.Id }));
  if (route.method === 'GET' && route.input === 'OrderQuery') for (const [name, schema] of Object.entries(schemas.OrderQuery.properties)) {
    parameters.push({ name, in: 'query', required: false, schema });
  }
  const entry = { operationId: route.operation, tags: [route.owner],
    security: route.roles.length ? [{ serverCredential: [] }] : [],
    'x-roles': route.roles, 'x-permission': route.permission,
    ...(parameters.length ? { parameters } : {}),
    ...(route.input && (route.method === 'POST' || route.method === 'PATCH') ? { requestBody: { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${route.input}` } } } } } : {}),
    responses: { '200': { description: 'Operation result; absent modules return 503', content: { 'application/json': { schema: { $ref: `#/components/schemas/${route.output}` } } } }, ...errors }
  };
  (paths[route.path] ??= {})[route.method.toLowerCase()] = entry;
}
paths['/health'] = { get: { operationId: 'health', security: [], responses: { '200': { description: 'Process liveness only; not business/readiness verification' } } } };
paths['/webhooks/zalo'] = { post: { operationId: 'zaloWebhook', tags: ['AI2'], security: [],
  description: 'Provider raw-body verification required in AI2 adapter. Provider signature/header contract is not yet verified. Unconfigured: 503.',
  responses: { '200': { description: 'Verified adapter acknowledgement (provider contract pending)' }, ...errors } } };
const openapi = { openapi: '3.1.0', info: { title: 'AUTO-IN Minh Điến', version: '0.1.0' }, paths,
  components: { schemas, securitySchemes: { serverCredential: { type: 'http', scheme: 'bearer', description: 'Logical server-verified credential. AI1 session transport/CSRF implementation pending; client role/actor is forbidden.' } } } };
const files = { 'schema.json': schemaDoc, 'openapi.json': openapi };
const dir = fileURLToPath(new URL('./generated/', import.meta.url));
await mkdir(dir, { recursive: true });
for (const [name, data] of Object.entries(files)) {
  const path = dir + name;
  const content = JSON.stringify(data) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== content) throw new Error(`Stale generated contract: ${name}`);
  } else await writeFile(path, content);
}
console.info(process.argv.includes('--check') ? 'Contracts up to date' : 'Contracts exported');
