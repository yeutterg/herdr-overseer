'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyBlock, stripBlock, block, BEGIN } = require('../lib/layout');

const BASE = 'onboarding = false\n[ui]\nagent_panel_sort = "priority"\n';

test('apply is idempotent and strip restores the original', () => {
  const once = applyBlock(BASE);
  assert.ok(once.includes(BEGIN));
  assert.equal(applyBlock(once), once);
  assert.equal(stripBlock(once), BASE);
});

test('refuses to fight another sidebar table', () => {
  assert.throws(() => applyBlock(`${BASE}[ui.sidebar.agents]\nrows = []\n`), /already defines/);
});

test('block stays within Herdr limits', () => {
  const text = block();
  const spaces = text.split('[ui.sidebar.spaces]')[1];
  const rows = spaces.split('\n').filter((l) => l.startsWith('  ['));
  assert.ok(rows.length <= 16);
});
