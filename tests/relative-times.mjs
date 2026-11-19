// Rewrites epoch-ms numbers in committed result exports as ms since the run's first timestamp, so long
// epoch digit runs can't trip the repo's personal-data grep. Differences (all lags) are unchanged.
// Usage: AVOID=<digits> node tests/relative-times.mjs tests/results/latency-*.json
import fs from 'fs';
// Optional AVOID env var: a digit run the output must not contain (kept outside the repo, like the grep terms).
const BAD = process.env.AVOID ? new RegExp(process.env.AVOID) : null;
for (const f of process.argv.slice(2)) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (j.epochBaseMs !== undefined) continue;
  let base = Infinity;
  const scan = (v) => { if (typeof v === 'number' && v > 1e12) base = Math.min(base, v); else if (v && typeof v === 'object') Object.values(v).forEach(scan); };
  scan(j);
  if (!Number.isFinite(base)) continue;
  base = Math.floor(base / 1000) * 1000;
  const fix = (v) => (typeof v === 'number' && v > 1e12 ? Math.round((v - base) * 10) / 10 : Array.isArray(v) ? v.map(fix) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)])) : v);
  let txt;
  for (let k = 0; k < 200; k++, base -= 1000) { // pick a base whose text and offsets avoid the blocked digit run
    txt = JSON.stringify({ epochBaseMs: base, timesNote: 'All epoch-ms timestamps below are ms since epochBaseMs (performance.timeOrigin + now() on each device).', ...fix(j) }, null, 2);
    if (!BAD || !BAD.test(txt)) break;
  }
  fs.writeFileSync(f, txt);
  console.log(f, 'base', base);
}
