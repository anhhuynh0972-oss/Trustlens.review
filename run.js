// Node runner: `npm test`. Runs every *.tests.js file with the shared harness.
const H = require('./harness.js');
const fs = require('fs');
const path = require('path');
for (const f of fs.readdirSync(__dirname).filter(f => f.endsWith('.tests.js')).sort()) require(path.join(__dirname, f));
const live = process.env.TRUSTLENS_LIVE === '1';
H.run(t => !t.opts.browserOnly && (!t.opts.live || live), r => {
  console.log(`${r.status === 'passed' ? 'PASS' : r.status === 'failed' ? 'FAIL' : 'SKIP'}${r.mock ? ' [mock]' : ''} ${r.name}${r.error ? '\n     ' + r.error : ''}`);
}).then(results => {
  const c = s => results.filter(r => r.status === s).length;
  console.log(`\n${c('passed')} passed, ${c('failed')} failed, ${c('skipped')} skipped (browser-only UI tests run in tests/browser.html)`);
  process.exitCode = c('failed') ? 1 : 0;
});
