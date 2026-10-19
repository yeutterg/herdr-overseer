'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyBlock, stripBlock, block, BEGIN } = require('../lib/layout');

const BASE = 'onboarding = false\n[ui]\nagent_panel_sort = "priority"\n';

test('apply is idempotent and strip restores the original', () => {
  const once = applyBlock(BASE, 'node live.js --tick');
  assert.equal(once.timer, true);
  assert.ok(once.text.includes(BEGIN));
  assert.equal(applyBlock(once.text, 'node live.js --tick').text, once.text);
  assert.equal(stripBlock(once.text), BASE);
});

test('the timer lands inside [ui], and never over a user tab bar', () => {
  const { text } = applyBlock(BASE, 'node live.js --tick');
  const ui = text.indexOf('[ui]\n');
  assert.ok(text.indexOf('tab_bar_right') > ui && text.indexOf('tab_bar_right') < text.indexOf('agent_panel_sort'));
  const own = applyBlock(`${BASE}tab_bar_right = []\n`, 'node live.js --tick');
  assert.equal(own.timer, false);
  assert.equal((own.text.match(/tab_bar_right/g) ?? []).length, 1);
  const noUi = applyBlock('onboarding = false\n', 'x');
  assert.ok(/\[ui\]\n# >>> herdr-glance timer/.test(noUi.text));
});

test('refuses to fight another sidebar table', () => {
  assert.throws(() => applyBlock(`${BASE}[ui.sidebar.agents]\nrows = []\n`, 'x'), /already defines/);
});

test('block stays within Herdr limits', () => {
  const text = block();
  const spaces = text.split('[ui.sidebar.spaces]')[1];
  const rows = spaces.split('\n').filter((l) => l.startsWith('  ['));
  assert.ok(rows.length <= 16);
});
