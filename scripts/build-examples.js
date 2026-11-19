// Writes golden snapshots of every example for both RouterOS versions into /configs.
// CI re-runs this and fails if `git diff` is non-empty, so generator changes are always reviewed as config diffs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { generate } from '../public/js/generator.js';
import { SCENARIOS } from '../public/js/examples.js';

mkdirSync(new URL('../configs/', import.meta.url), { recursive: true });
let n = 0;
for (const [name, build] of Object.entries(SCENARIOS)) {
  for (const version of ['6', '7']) {
    const r = generate({ ...build(), version });
    if (!r.ok) throw new Error(`${name} v${version}: ${JSON.stringify(r.errors)}`);
    writeFileSync(new URL(`../configs/${name}.v${version}.rsc`, import.meta.url), r.script);
    n++;
  }
}
console.log(`wrote ${n} snapshots to configs/`);
