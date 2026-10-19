'use strict';

// Herdr's socket API: newline-delimited JSON, one request per connection.
// Faster than spawning the `herdr` CLI for every call, and calls run in
// parallel because each opens its own connection.

const net = require('node:net');
const { socketPath } = require('./session');

const TIMEOUT_MS = 4000;

// Resolves to `result` on success. Throws on transport failure or an API
// error so callers can decide what a refusal means. `sock` targets another
// session's server.
function call(method, params = {}, sock = socketPath()) {
  return new Promise((resolve, reject) => {
    const stream = net.connect({ path: sock });
    let body = '';
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    stream.setTimeout(TIMEOUT_MS, () => finish(new Error(`${method}: timed out`)));
    stream.on('error', (err) => finish(err));
    stream.on('connect', () => stream.write(`${JSON.stringify({ id: 'overseer', method, params })}\n`));
    stream.on('data', (chunk) => {
      body += chunk;
      const end = body.indexOf('\n');
      if (end < 0) return;
      let reply;
      try {
        reply = JSON.parse(body.slice(0, end));
      } catch (err) {
        return finish(err);
      }
      if (reply.error) return finish(new Error(`${method}: ${reply.error.message ?? reply.error.code}`));
      finish(null, reply.result);
    });
  });
}

async function snapshot(sock) {
  return (await call('session.snapshot', {}, sock)).snapshot;
}

module.exports = { call, snapshot };
