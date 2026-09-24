// Dependency-free lint: syntax-check every server + frontend JS file, and flag debug leftovers.
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const roots = [path.join(__dirname, '..'), path.join(__dirname, '..', '..', 'public', 'js')];
let bad = 0;
function walk(d) {
  for (const f of fs.readdirSync(d)) {
    if (f === 'node_modules' || f === 'uploads') continue;
    const p = path.join(d, f), s = fs.statSync(p);
    if (s.isDirectory()) walk(p);
    else if (f.endsWith('.js')) {
      const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
      if (r.status !== 0) { bad++; console.error(r.stderr); }
      if (p !== __filename && new RegExp('\b' + 'debug' + 'ger\b').test(fs.readFileSync(p, 'utf8'))) { bad++; console.error('leftover breakpoint statement in ' + p); }
    }
  }
}
roots.forEach((r) => fs.existsSync(r) && walk(r));
if (bad) { console.error(`${bad} problem(s)`); process.exit(1); }
console.log('lint ok');
