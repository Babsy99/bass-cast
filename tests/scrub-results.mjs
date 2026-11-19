// Rewrites epoch-millisecond numbers in tests/results/*.json as ISO strings (lossless, readable,
// and keeps long random digit runs out of the repo).
import fs from 'node:fs';
const dir = 'tests/results';
const fix = (v) => Array.isArray(v) ? v.map(fix) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]))
  : typeof v === 'number' && v > 1.5e12 && v < 2.5e12 ? new Date(v).toISOString() : v;
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const p = `${dir}/${f}`; fs.writeFileSync(p, JSON.stringify(fix(JSON.parse(fs.readFileSync(p, 'utf8'))), null, 2));
}
console.log('scrubbed');
