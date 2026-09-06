'use strict';
// Regression test for the Windows startup failure.
//
// The original start.bat contained:
//     if !ERRORLEVEL! neq 0 (
//         echo   ERROR: Node.js is not installed.
//         echo   Download it free from https://nodejs.org (v22.5+ required)
//         echo.
//         pause
//         exit /b 1
//     )
//
// cmd.exe treats the unescaped ")" in that echo as the END of the IF block.
// Everything after it - including PAUSE and EXIT /B 1 - therefore ran
// unconditionally, so the launcher printed "Press any key to continue . . ."
// and exited on every single run, before ever starting the server.
//
// These checks fail if that class of bug is reintroduced.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const failures = [];
const checks = [];

function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (e) {
    checks.push({ name, ok: false, err: e.message });
    failures.push(name + ': ' + e.message);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function readLines(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/);
}

// Returns every line where an ECHO inside a parenthesised block contains an
// unescaped ")" - i.e. the exact defect that broke start.bat.
function findBlockClosingEchoes(lines) {
  const bad = [];
  let depth = 0;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('REM ') || line.startsWith('::')) return;

    if (/^echo\b/i.test(line) || /^echo\./i.test(line)) {
      if (depth > 0) {
        // an unescaped ")" is any ")" not preceded by "^"
        for (let c = 0; c < line.length; c++) {
          if (line[c] === ')' && line[c - 1] !== '^') {
            bad.push({ line: i + 1, text: raw.trim() });
            break;
          }
        }
      }
      return; // echo text must not affect block depth tracking
    }

    for (let c = 0; c < line.length; c++) {
      if (line[c] === '^') { c++; continue; }
      if (line[c] === '(') depth++;
      else if (line[c] === ')') depth = Math.max(0, depth - 1);
    }
  });
  return bad;
}

for (const file of ['start.bat', 'stop.bat']) {
  check(file + ': no unescaped ")" in echo inside an if-block', () => {
    const bad = findBlockClosingEchoes(readLines(file));
    assert(bad.length === 0,
      'these echoes would close their IF block early: ' +
      bad.map(b => 'line ' + b.line + ' -> ' + b.text).join(' ; '));
  });

  check(file + ': parentheses are balanced', () => {
    const lines = readLines(file);
    let depth = 0;
    lines.forEach(raw => {
      const line = raw.trim();
      if (!line || line.startsWith('REM ') || line.startsWith('::')) return;
      if (/^echo\b/i.test(line) || /^echo\./i.test(line)) return;
      for (let c = 0; c < line.length; c++) {
        if (line[c] === '^') { c++; continue; }
        if (line[c] === '(') depth++;
        else if (line[c] === ')') depth--;
      }
    });
    assert(depth === 0, 'unbalanced parentheses (depth ended at ' + depth + ')');
  });

  check(file + ': uses its own directory as project root', () => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert(/cd\s+\/d\s+"%~dp0"/i.test(src), 'missing  cd /d "%~dp0"');
  });
}

// The core regression: on the success path start.bat must reach the launcher
// BEFORE it can ever reach a PAUSE.
check('start.bat: reaches the launcher before any pause', () => {
  const lines = readLines('start.bat');
  const launcherLine = lines.findIndex(l => /node\s+"src\\launcher\.js"/i.test(l));
  const pauseLine = lines.findIndex(l => /^\s*pause\s*$/i.test(l));
  assert(launcherLine !== -1, 'start.bat never invokes src\\launcher.js');
  assert(pauseLine !== -1, 'start.bat has no pause at all (errors would vanish)');
  assert(launcherLine < pauseLine,
    'a PAUSE at line ' + (pauseLine + 1) + ' comes before the launcher at line ' +
    (launcherLine + 1) + ' - the server would never start');
});

check('start.bat: every pause sits after a label (not on the straight-line path)', () => {
  const lines = readLines('start.bat');
  const launcherLine = lines.findIndex(l => /node\s+"src\\launcher\.js"/i.test(l));
  lines.forEach((l, i) => {
    if (!/^\s*pause\s*$/i.test(l)) return;
    assert(i > launcherLine,
      'pause on line ' + (i + 1) + ' executes before the launcher runs');
  });
});

check('stop.bat: does not kill node by image name', () => {
  const src = fs.readFileSync(path.join(ROOT, 'stop.bat'), 'utf8') +
              fs.readFileSync(path.join(ROOT, 'src', 'stop.js'), 'utf8');
  assert(!/\/IM\s+node\.exe/i.test(src),
    'found "taskkill /IM node.exe" - that would kill unrelated Node processes');
  assert(!/taskkill[^\n]*\/F[^\n]*\/IM/i.test(src),
    'found a taskkill by image name');
});

check('start.bat: invokes npm with "call"', () => {
  const lines = readLines('start.bat');
  lines.forEach((l, i) => {
    if (/(^|\s)npm\s/i.test(l) && !/^\s*REM/i.test(l) && !/^\s*echo/i.test(l)) {
      assert(/^\s*call\s+npm\s/i.test(l.trim()) || /^\s*if\s+/i.test(l.trim()),
        'npm on line ' + (i + 1) + ' must be invoked with "call"');
    }
  });
});

check('launcher/server: no hardcoded cwd assumptions', () => {
  for (const f of ['src/server.js', 'src/launcher.js', 'src/stop.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert(/__dirname/.test(src), f + ' should resolve paths from __dirname');
  }
});

// ---------------------------------------------------------------------------
console.log('\n  Batch launcher lint');
console.log('  -------------------');
for (const c of checks) {
  console.log('  ' + (c.ok ? 'PASS' : 'FAIL') + '  ' + c.name + (c.ok ? '' : '\n        ' + c.err));
}
console.log('');
console.log('  ' + checks.filter(c => c.ok).length + '/' + checks.length + ' passed');
console.log('');

process.exitCode = failures.length ? 1 : 0;
