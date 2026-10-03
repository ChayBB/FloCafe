#!/usr/bin/env node

'use strict';

// npm hands a script to the platform shell as one command line, and cmd.exe
// refuses anything over 8191 characters with "The command line is too long."
// `npm test` once grew past that and could not start on Windows at all — the
// whole suite silently unrunnable on a supported platform.
//
// The headroom below leaves room for a few more suites before anyone has to
// think about this again; past it, split the script rather than raising the
// limit, because the limit is the platform's and not ours to choose.

const fs = require('node:fs');
const path = require('node:path');

const CMD_LIMIT = 8191;
const HEADROOM = 1500;
const MAX = CMD_LIMIT - HEADROOM;

function main() {
  const packagePath = path.join(__dirname, '..', '..', 'package.json');
  const scripts = JSON.parse(fs.readFileSync(packagePath, 'utf8')).scripts || {};

  const offenders = Object.entries(scripts)
    .map(([name, command]) => ({ name, length: command.length }))
    .filter((entry) => entry.length > MAX)
    .sort((a, b) => b.length - a.length);

  if (offenders.length > 0) {
    console.error(`\npackage.json scripts too long for cmd.exe (limit ${CMD_LIMIT}, allowed ${MAX}):\n`);
    for (const { name, length } of offenders) {
      console.error(`  ${name}: ${length} characters`);
    }
    console.error('\nSplit the script into smaller ones it calls in turn. Keeping each');
    console.error('piece a `test:*` script preserves the coverage closure that');
    console.error('validate-test-script-coverage.cjs walks.\n');
    process.exit(1);
  }

  const longest = Object.entries(scripts)
    .reduce((worst, [name, command]) => (command.length > worst.length ? { name, length: command.length } : worst),
      { name: '(none)', length: 0 });
  console.log(`Script command lengths OK: longest is ${longest.name} at ${longest.length} of ${MAX} allowed.`);
}

main();
