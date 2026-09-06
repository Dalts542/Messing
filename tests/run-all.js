'use strict';
// Runs the full test suite. No npm dependencies.
const { spawnSync } = require('child_process');
const path = require('path');

const suites = [
  ['Batch launcher lint (startup regression)', 'batch-lint.test.js'],
  ['Startup / health / pages smoke test', 'smoke.test.js'],
  ['Launcher lifecycle (start/stop/restart)', 'launcher.test.js']
];

let failed = 0;
for (const [label, file] of suites) {
  console.log('\n=== ' + label + ' ===');
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], {
    stdio: 'inherit',
    env: { ...process.env }
  });
  if (r.status !== 0) { failed++; console.log('  --> FAILED (exit ' + r.status + ')'); }
}

console.log('\n============================================');
console.log(failed === 0
  ? '  ALL SUITES PASSED'
  : '  ' + failed + ' SUITE(S) FAILED');
console.log('============================================\n');
process.exit(failed === 0 ? 0 : 1);
