import { DatabaseSync } from 'node:sqlite';
import { toAlbers, ENDPOINT, parseCdlResponse } from './cropscan.mjs';

const db = new DatabaseSync('spypoint-data/trailcam.db', { readOnly: true });
const fields = db.prepare('SELECT id,name,crop,points FROM fields').all();

let cx = 0, cy = 0, n = 0;
for (const r of fields) {
  const pts = JSON.parse(r.points);                    // [lng, lat]
  const mlat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const mx = 111320 * Math.cos(mlat * Math.PI / 180), my = 110540;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += (pts[i][0] * mx) * (pts[j][1] * my) - (pts[j][0] * mx) * (pts[i][1] * my);
  }
  const acres = Math.abs(a / 2) / 4046.86;
  const px = Math.sqrt(acres * 4046.86) / 10;
  console.log(`  #${r.id} ${(r.name || '?').padEnd(16)} ${r.crop.padEnd(9)} ${acres.toFixed(1).padStart(6)} ac  ~${Math.round(px * px)} Sentinel pixels`);
  cx += pts.reduce((s, p) => s + p[0], 0) / pts.length; cy += mlat; n++;
}
const clng = cx / n, clat = cy / n;
db.close();

// Neighbourhood crop mix around the property centroid. Coordinates never printed.
const R = 2000, G = 9;
const jobs = [];
for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) {
  const dLat = (2 * R * (i / (G - 1) - 0.5)) / 110540;
  const dLng = (2 * R * (j / (G - 1) - 0.5)) / (111320 * Math.cos(clat * Math.PI / 180));
  jobs.push([clat + dLat, clng + dLng]);
}
const YEAR = 2025;
async function one([la, lo]) {
  const { x, y } = toAlbers(la, lo);
  try {
    const r = await fetch(`${ENDPOINT()}?year=${YEAR}&x=${x.toFixed(1)}&y=${y.toFixed(1)}`);
    return parseCdlResponse(await r.text()).category;
  } catch { return null; }
}
const out = [];
for (let i = 0; i < jobs.length; i += 6) {
  out.push(...await Promise.all(jobs.slice(i, i + 6).map(one)));
}
const tally = {};
for (const c of out) if (c) tally[c] = (tally[c] || 0) + 1;
const total = Object.values(tally).reduce((a, b) => a + b, 0);
console.log(`\nCDL ${YEAR} within ${R} m of the property centre (${total}/${jobs.length} answered):`);
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${String(v).padStart(3)}  ${(100 * v / total).toFixed(0)}%`);
}
