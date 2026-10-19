#!/usr/bin/env node
'use strict';

// Focus hooks: only the window title, so switching spaces stays instant.

const { snapshot } = require('../lib/ipc');
const { applyTitle } = require('../lib/title');

snapshot()
  .then(applyTitle)
  .catch((err) => {
    console.error(`herdr-glance title: ${err.message}`);
    process.exitCode = 1;
  });
