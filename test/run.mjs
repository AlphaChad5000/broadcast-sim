// Runs every test/*.test.mjs in its own process.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.test.mjs')).sort()) {
  console.log(`\n== ${f}`);
  const r = spawnSync(process.execPath, [path.join(dir, f), ...process.argv.slice(2)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
