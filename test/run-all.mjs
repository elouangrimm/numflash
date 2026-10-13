import { spawnSync } from 'node:child_process';
let bad = 0;
for (const t of ['diff-vs-official', 'installer-diff', 'safety', 'glue-boot']) {
  console.log('\n== ' + t);
  const r = spawnSync(process.execPath, [new URL(`./${t}.mjs`, import.meta.url).pathname], { stdio: 'inherit' });
  if (r.status) bad++;
}
console.log(bad ? `\n${bad} test file(s) FAILED` : '\nAll tests passed');
process.exit(bad ? 1 : 0);
