// Offline build: derive a per-trait color table for the pre-deploy homage sample
// generator (src/components/collections/homage/synthetic-punk.ts).
//
// Punks are a fixed 10k set and the SDK can't composite a punk from traits, so to
// generate NOVEL punks (a full trait list whose colors are coherent with the traits)
// we precompute, for each HeadVariant and Accessory, the colors that trait contributes
// and their typical pixel counts — derived from the real collection:
//   - head skin ramps: colors present in most of a head's punks, ranked by avg pixel area
//   - accessory colors: colors ENRICHED in an accessory's punks (present in most of them,
//     rare collection-wide), so skin tones don't leak in
// Plus the accessory-count distribution and an accessory incompatibility graph (pairs that
// never co-occur in the real 10k = mutually exclusive slots). The runtime generator samples
// a head + compatible accessories in these ratios, sums their color profiles, and renders
// the homage through the same distill/rings/svg pipeline. No SDK at runtime.
//
// Run: node apps/web/scripts/build-homage-traits.mjs
// Writes: apps/web/public/data/homage-traits.json

import { writeFileSync } from "node:fs";
import { createPunksSdk } from "@networked-art/punks-sdk";
import { bundledOfflinePunksDataWithPixels } from "@networked-art/punks-sdk/offline-pixel-data";

const sdk = createPunksSdk({ dataset: bundledOfflinePunksDataWithPixels });
const ds = sdk.dataset;
const src = ds.source;
const N = 10_000;

const palette = ds.palette({ includeSupplies: true });
const palById = new Map();
for (const c of palette) palById.set(c.id, c);
const opaque = palette.filter((c) => c.a >= 128);

function popcount(bm) {
  let n = 0;
  for (const w of bm) {
    let x = w >>> 0;
    while (x) { x &= x - 1; n++; }
  }
  return n;
}
function andCount(a, b) {
  let n = 0;
  const L = Math.min(a.length, b.length);
  for (let i = 0; i < L; i++) {
    let x = (a[i] & b[i]) >>> 0;
    while (x) { x &= x - 1; n++; }
  }
  return n;
}
const rgbInt = (c) => (c.r << 16) | (c.g << 8) | c.b;

const traitBitmap = (name) => ds.bitmap({ attributes: { required: [name] } });
const traitIds = (name) => ds.search({ attributes: { required: [name] } });

function stride(arr, k) {
  const out = [];
  const step = arr.length / k;
  for (let i = 0; i < k; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

// Per-color pixel stats over a sample of a trait's punks: avg pixel count + presence
// (fraction of sampled punks containing the color).
function pixelStats(ids, cap = 200) {
  const sample = ids.length > cap ? stride(ids, cap) : ids;
  const total = new Map();
  const present = new Map();
  for (const id of sample) {
    const px = ds.indexedPixels(id);
    const seen = new Set();
    for (let p = 0; p < px.length; p++) {
      const cid = px[p];
      const c = palById.get(cid);
      if (!c || c.a < 128) continue;
      total.set(cid, (total.get(cid) ?? 0) + 1);
      seen.add(cid);
    }
    for (const cid of seen) present.set(cid, (present.get(cid) ?? 0) + 1);
  }
  const n = sample.length || 1;
  const stats = new Map();
  for (const [cid, t] of total) {
    stats.set(cid, { avg: t / n, presence: (present.get(cid) ?? 0) / n });
  }
  return stats;
}

// A head's skin ramp: colors present in most of its punks, ranked by avg pixel area.
function headProfile(name) {
  const ids = traitIds(name);
  const stats = pixelStats(ids);
  // Skin ramp = colors reliably present in the head (skin shades + black features), ranked
  // by pixel area. A lower presence floor catches shading shades that a partial cover dips.
  const colors = [...stats.entries()]
    .filter(([, s]) => s.presence >= 0.4)
    .sort((a, b) => b[1].avg - a[1].avg)
    .slice(0, 10)
    .map(([cid, s]) => [rgbInt(palById.get(cid)), Math.round(s.avg)]);
  return { name, supply: ids.length, colors };
}

// An accessory's colors: enriched within its punks (present in most, rare globally), with
// their real avg pixel counts. Enrichment strips skin tones (not accessory-specific).
function accessoryProfile(name) {
  const T = traitBitmap(name);
  const tN = popcount(T) || 1;
  const stats = pixelStats(traitIds(name));
  const colors = [];
  for (const c of opaque) {
    const cb = src.getColorBitmapSync(c.id);
    const presence = andCount(T, cb) / tN;
    const global = popcount(cb) / N;
    const enr = global > 0 ? presence / global : 0;
    if (presence >= 0.5 && enr >= 3) {
      colors.push([rgbInt(c), Math.max(1, Math.round(stats.get(c.id)?.avg ?? 1)), enr]);
    }
  }
  colors.sort((a, b) => b[2] - a[2]);
  return { name, supply: tN, colors: colors.slice(0, 6).map(([rgb, cnt]) => [rgb, cnt]) };
}

console.log("heads…");
const heads = ds.traits().filter((t) => t.kind === "HeadVariant").map((t) => headProfile(t.name));

console.log("accessories…");
const accessories = ds
  .traits()
  .filter((t) => t.kind === "Accessory")
  .map((t) => accessoryProfile(t.name))
  .filter((a) => a.colors.length > 0);

console.log("incompatibility graph…");
const accBitmaps = accessories.map((a) => traitBitmap(a.name));
const incompatible = accessories.map(() => []);
for (let i = 0; i < accessories.length; i++) {
  for (let j = i + 1; j < accessories.length; j++) {
    if (andCount(accBitmaps[i], accBitmaps[j]) === 0) {
      incompatible[i].push(j);
      incompatible[j].push(i);
    }
  }
}

const attrCounts = ds
  .traits()
  .filter((t) => t.kind === "AttributeCount")
  .map((t) => [parseInt(t.name, 10), t.supply])
  .filter(([n]) => Number.isFinite(n))
  .sort((a, b) => a[0] - b[0]);

const out = { heads, accessories, incompatible, attrCounts };
const url = new URL("../public/data/homage-traits.json", import.meta.url);
writeFileSync(url, JSON.stringify(out));
console.log(
  `wrote ${url.pathname}: ${heads.length} heads, ${accessories.length} accessories, ` +
    `${attrCounts.length} count buckets`,
);
