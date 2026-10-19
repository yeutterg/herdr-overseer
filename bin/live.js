#!/usr/bin/env node
'use strict';

// Focus hooks and the tab-bar timer: selection, wrapped activity and the
// window title. Prints nothing, so the tab-bar slot it runs from stays empty.

const { updateLive } = require('../lib/live');

const tick = process.argv.includes('--tick');

updateLive(null, { forceTitle: !tick }).catch((err) => {
  if (!tick) console.error(`herdr-overseer live: ${err.message}`);
  process.exitCode = tick ? 0 : 1;
});
