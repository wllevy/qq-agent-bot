import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedUser } from '../src/access.js';

test('访问限制默认拒绝，仅精确匹配获准senderId，无通配符和前缀匹配', () => {
  assert.equal(allowedUser([], 'owner'), false);
  assert.equal(allowedUser(['owner'], 'owner'), true);
  assert.equal(allowedUser(['owner'], 'owner-other'), false);
  assert.equal(allowedUser(['*'], 'owner'), false);
  assert.equal(allowedUser([''], ''), false);
});
