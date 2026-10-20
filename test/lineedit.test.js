'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { edit } = require('../lib/lineedit');

const run = (keys, state = { text: '', cursor: 0 }) => keys.reduce((s, k) => edit(s, k) ?? s, state);

test('types, moves and deletes by character', () => {
  assert.deepEqual(run(['hello', '\x1b[D', '\x1b[D', 'X']), { text: 'helXlo', cursor: 4 });
  assert.deepEqual(run(['abc', '\x1b[D', '\x7f']), { text: 'ac', cursor: 1 });
  assert.deepEqual(run(['abc', '\x01', '\x1b[3~']), { text: 'bc', cursor: 0 });
});

test('option+arrows move by word, in every encoding', () => {
  const start = { text: 'fix the ota-retry bug', cursor: 21 };
  for (const left of ['\x1bb', '\x1b[1;3D', '\x1b[1;9D']) {
    assert.equal(run([left], start).cursor, 18);
    assert.equal(run([left, left], start).cursor, 12);
    assert.equal(run([left, left, left], start).cursor, 8);
  }
  for (const right of ['\x1bf', '\x1b[1;3C']) assert.equal(run([right], { ...start, cursor: 0 }).cursor, 3);
});

test('option+backspace deletes the word before the cursor', () => {
  assert.deepEqual(run(['\x1b\x7f'], { text: 'retry ota now ', cursor: 14 }), { text: 'retry ota ', cursor: 10 });
  assert.deepEqual(run(['\x17'], { text: 'retry ota now', cursor: 9 }), { text: 'retry  now', cursor: 6 });
  assert.deepEqual(run(['\x1bd'], { text: 'retry ota now', cursor: 5 }), { text: 'retry now', cursor: 5 });
});

test('pastes insert at the cursor and flatten newlines', () => {
  assert.deepEqual(run(['a\nb'], { text: 'xy', cursor: 1 }), { text: 'xa by', cursor: 4 });
  assert.equal(edit({ text: '', cursor: 0 }, '\x1b[Z'), null);
});
