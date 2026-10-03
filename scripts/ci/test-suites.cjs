#!/usr/bin/env node

'use strict';

// The flat, ordered list of suites the default run executes.
//
// `test` delegates to `test:batch-N` scripts because npm hands a script to the
// shell as one command line and cmd.exe caps that at 8191 characters. Anything
// that wants the actual suites — CI sharding, the dev-tooling checks — needs
// the list behind that indirection rather than the four batch names.
//
// Only batch scripts are expanded. Several real suites (test:dev-tooling,
// test:phase2) invoke other `test:*` scripts of their own, and CI treats each
// of those as a single schedulable unit; expanding them would change what a
// shard is.

const SUITE_PATTERN = /(?:bash\s+tests\/run-test\.sh\s+)?npm\s+run\s+(test:[\w-]+)/g;
const BATCH_PATTERN = /^test:batch-\d+$/;

function extractSuiteNames(command) {
  const names = [];
  let match;
  const pattern = new RegExp(SUITE_PATTERN.source, 'g');
  while ((match = pattern.exec(command || '')) !== null) {
    names.push(match[1]);
  }
  return names;
}

/** Suites the default `test` run executes, in order, without duplicates. */
function listDefaultSuites(pkg) {
  const scripts = (pkg && pkg.scripts) || {};
  const suites = [];
  for (const name of extractSuiteNames(scripts.test)) {
    const expanded = BATCH_PATTERN.test(name) ? extractSuiteNames(scripts[name]) : [name];
    for (const suite of expanded) {
      if (!suites.includes(suite)) suites.push(suite);
    }
  }
  return suites;
}

module.exports = { listDefaultSuites, extractSuiteNames, BATCH_PATTERN };
