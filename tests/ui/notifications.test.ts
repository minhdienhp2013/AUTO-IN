import test from 'node:test';
import assert from 'node:assert/strict';
import { orderFromNavigation } from '../../web/src/notifications.ts';

test('push navigation never uses arbitrary URLs or malformed order ids',()=>{
 assert.deepEqual(orderFromNavigation('?order_id=MD-001&revision=5'),{id:'MD-001',revision:5});
 assert.equal(orderFromNavigation('?order_id=../../etc/passwd').id,null);
 assert.equal(orderFromNavigation('?order_id=https://evil.example').id,null);
 assert.equal(orderFromNavigation('?order_id=MD-001&revision=-1').revision,null);
});