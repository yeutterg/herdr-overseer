'use strict';

// A one-line text editor for the overview's note prompt: a cursor, word-wise
// movement and deletion (option+arrows, option+backspace), and the usual
// readline keys. Terminals send option combos several ways, so each action
// lists every sequence seen for it (meta-prefixed, xterm modifiers, ctrl).
//
// State is { text, cursor }, cursor counted in code points. edit() returns
// the new state, or null when the key is not an editing key.

const KEYS = {
  left: ['\x1b[D', '\x1bOD', '\x02'],
  right: ['\x1b[C', '\x1bOC', '\x06'],
  wordLeft: ['\x1bb', '\x1b[1;3D', '\x1b[1;9D', '\x1b[1;5D', '\x1b\x1b[D'],
  wordRight: ['\x1bf', '\x1b[1;3C', '\x1b[1;9C', '\x1b[1;5C', '\x1b\x1b[C'],
  home: ['\x1b[H', '\x1bOH', '\x1b[1~', '\x01', '\x1b[1;2D', '\x1b[1;9H'],
  end: ['\x1b[F', '\x1bOF', '\x1b[4~', '\x05', '\x1b[1;2C', '\x1b[1;9F'],
  backspace: ['\x7f', '\b'],
  del: ['\x1b[3~', '\x04'],
  wordBackspace: ['\x1b\x7f', '\x1b\b', '\x17'],
  wordDel: ['\x1bd', '\x1b[3;3~'],
  killStart: ['\x15'],
  killEnd: ['\x0b'],
};
const ACTION = new Map(Object.entries(KEYS).flatMap(([a, seqs]) => seqs.map((s) => [s, a])));

const isWord = (ch) => /[\p{L}\p{N}_]/u.test(ch);

// Start of the word before i (skipping separators first), as readline does.
function wordStart(chars, i) {
  while (i > 0 && !isWord(chars[i - 1])) i--;
  while (i > 0 && isWord(chars[i - 1])) i--;
  return i;
}

function wordEnd(chars, i) {
  while (i < chars.length && !isWord(chars[i])) i++;
  while (i < chars.length && isWord(chars[i])) i++;
  return i;
}

function edit({ text, cursor }, key) {
  const chars = [...text];
  const at = Math.max(0, Math.min(cursor, chars.length));
  const cut = (from, to) => ({ text: [...chars.slice(0, from), ...chars.slice(to)].join(''), cursor: from });
  const action = ACTION.get(key);
  switch (action) {
    case 'left': return { text, cursor: Math.max(0, at - 1) };
    case 'right': return { text, cursor: Math.min(chars.length, at + 1) };
    case 'wordLeft': return { text, cursor: wordStart(chars, at) };
    case 'wordRight': return { text, cursor: wordEnd(chars, at) };
    case 'home': return { text, cursor: 0 };
    case 'end': return { text, cursor: chars.length };
    case 'backspace': return at ? cut(at - 1, at) : { text, cursor: at };
    case 'del': return cut(at, Math.min(chars.length, at + 1));
    case 'wordBackspace': return cut(wordStart(chars, at), at);
    case 'wordDel': return cut(at, wordEnd(chars, at));
    case 'killStart': return cut(0, at);
    case 'killEnd': return cut(at, chars.length);
  }
  if (key.startsWith('\x1b')) return null;
  // Typed or pasted text: newlines become spaces, other controls are dropped.
  const typed = [...key.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '')];
  if (!typed.length) return null;
  return { text: [...chars.slice(0, at), ...typed, ...chars.slice(at)].join(''), cursor: at + typed.length };
}

module.exports = { edit };
