import assert from 'node:assert/strict';
import test from 'node:test';

test('shared package loads its rule parsers in the native production Node runtime', async () => {
  const shared = await import('@recat/shared');
  assert.equal(shared.parseRuleCurrentState('enabled'), 'enabled');
  assert.deepEqual(shared.parseRuleActionV2({
    version: 2,
    direction: 'Purchase',
    category: 'Software',
    categoryQboId: '99',
    taxCalculation: 'NotApplicable',
    taxCodeQboId: null,
    tagIds: [],
  }), {
    version: 2,
    direction: 'Purchase',
    category: 'Software',
    categoryQboId: '99',
    taxCalculation: 'NotApplicable',
    taxCodeQboId: null,
    tagIds: [],
  });
});
