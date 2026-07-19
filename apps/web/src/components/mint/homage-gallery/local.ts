"use client";

// Fully-local homage rendering for the gallery wall: the punk's pixels come from the
// networked-art SDK's bundled data (no RPC), and the homage is drawn by the parity-verified
// port (render.ts). Proven byte-identical to the on-chain renderer by the Homage repo's
// parity scripts. Port source: permanence origin/master:web/lib/homage/local.ts, trimmed to
// the wall's needs (the /explore analysis exports and the raw-punk view are not ported).
//
// The ~15MB pixel bundle is dynamic-imported, so it stays out of the initial page load and only
// loads when the first homage renders. All renders share one SDK instance.

import { useEffect, useState } from "react";
import { distill, rings, svg, groundForStatus } from "./render";
import { anySvgToSrc, type TokenMeta } from "./svg";

type Loaded = {
  sdk: {
    dataset: { indexedPixels: (id: number) => Uint8Array; palette: () => { id: number; r: number; g: number; b: number; a: number }[] };
    render: { metadata: (id: number) => { attributes?: { trait_type: string; value: string | number }[] } };
  };
  palById: { r: number; g: number; b: number; a: number }[];
};

let loading: Promise<Loaded> | null = null;
function getSdk(): Promise<Loaded> {
  if (!loading) {
    loading = (async () => {
      const [{ createPunksSdk }, { bundledOfflinePunksDataWithPixels }] = await Promise.all([
        import("@networked-art/punks-sdk"),
        import("@networked-art/punks-sdk/offline-pixel-data"),
      ]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sdk = createPunksSdk({ dataset: bundledOfflinePunksDataWithPixels }) as any;
      const palById: Loaded["palById"] = [];
      for (const e of sdk.dataset.palette()) palById[e.id] = e;
      return { sdk, palById };
    })();
  }
  return loading;
}

// Reconstruct the raw transparent-background RGBA (as CryptoPunksData.punkImage returns) from the
// SDK's indexed pixels + palette — index 0 is transparent. (render.rgba composites onto a solid
// background, which our distillation must not see.)
function pixels({ sdk, palById }: Loaded, id: number): Uint8Array {
  const idx = sdk.dataset.indexedPixels(id);
  const img = new Uint8Array(2304);
  for (let p = 0; p < 576; p++) {
    const e = palById[idx[p]];
    const o = p * 4;
    img[o] = e.r;
    img[o + 1] = e.g;
    img[o + 2] = e.b;
    img[o + 3] = e.a;
  }
  return img;
}

const STATUS_LABEL = ["Not For Sale", "Wrapped", "For Sale", "Has Bid"];

// Inject an intrinsic pixel size so a copied/saved raster is `px` wide, not the
// 240 the viewBox implies. Geometry stays in the 240 coordinate space (the
// contract's), so render.ts's byte-identical svg() is untouched — this only sets
// the display resolution.
function atSize(svg: string, px: number): string {
  return svg.replace("<svg ", `<svg width="${px}" height="${px}" `);
}

export type LocalHomage = { svg: string; colorCount: number; type: string; accessories: string[] };

/** Render a punk's homage fully locally. `status` colours the ground (default 0 = not for sale).
 *  `sizePx` sets the SVG's intrinsic size (copy/paste resolution); omit for the 240 default. */
export async function localHomage(
  id: number,
  opts: { status?: number; circle?: boolean; sizePx?: number } = {}
): Promise<LocalHomage> {
  const loaded = await getSdk();
  const img = pixels(loaded, id);
  const { cols, cnts } = distill(img);
  let svgStr = svg(groundForStatus(opts.status ?? 0), rings(cols, cnts), opts.circle ?? false);
  if (opts.sizePx) svgStr = atSize(svgStr, opts.sizePx);
  const attrs = loaded.sdk.render.metadata(id).attributes ?? [];
  const type = String(
    attrs.find((a) => a.trait_type === "Head Variant")?.value ?? attrs.find((a) => a.trait_type === "Type")?.value ?? ""
  );
  const accessories = attrs.filter((a) => a.trait_type === "Accessory").map((a) => String(a.value));
  return { svg: svgStr, colorCount: cols.length, type, accessories };
}

function toMeta(h: LocalHomage, status: number): TokenMeta {
  return {
    image: h.svg,
    attributes: [
      { trait_type: "Punk Type", value: h.type },
      ...h.accessories.map((a) => ({ trait_type: "Punk Accessory", value: a })),
      { trait_type: "Accessory Count", value: h.accessories.length },
      { trait_type: "Color Count", value: h.colorCount },
      { trait_type: "Status", value: STATUS_LABEL[status] ?? STATUS_LABEL[0] },
    ],
  };
}

/** Focus/reveal overlays — src + full trait metadata, rendered locally. `sizePx`
 *  sets the SVG's intrinsic copy/paste resolution. */
export function useLocalSample(id: number, status = 0, sizePx?: number) {
  const [state, setState] = useState<{ src?: string; meta?: TokenMeta; isLoading: boolean }>({ isLoading: true });
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, isLoading: true }));
    localHomage(id, { status, sizePx })
      .then((h) => {
        if (cancelled) return;
        setState({ src: anySvgToSrc(h.svg), meta: toMeta(h, status), isLoading: false });
      })
      .catch(() => {
        if (!cancelled) setState({ isLoading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [id, status, sizePx]);
  return state;
}

/** Wall tile — just the classic src, rendered locally. `sizePx` sets the SVG's
 *  intrinsic copy/paste resolution. */
export function useLocalArt(id: number, status = 0, sizePx?: number) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    localHomage(id, { status, sizePx })
      .then((h) => {
        if (!cancelled) setSrc(anySvgToSrc(h.svg));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, status, sizePx]);
  return { src };
}

// ── synthetic samples ─────────────────────────────────────────────────────────
// Novel homages that reproduce no real punk: the RING STRUCTURE (band count + pixel
// proportions) is borrowed from a random punk's distilled counts, but every COLOR is
// resampled from the collection palette weighted by real supply. The result is a
// plausible homage in collection-like color ratios that matches no punk's actual art.
// Used by the pre-deploy sample wall; the real-punk renders above still drive the
// /mint/homage gallery.

const MERGE_T_SYNTH = 24; // keep sampled ring colors at least this far apart (Manhattan)

// Collection palette (opaque colors + cumulative supply weights), loaded once.
type WeightedPalette = { colors: number[]; cum: number[]; total: number };
let palettePromise: Promise<WeightedPalette> | null = null;
function getWeightedPalette(): Promise<WeightedPalette> {
  if (!palettePromise) {
    palettePromise = getSdk().then(({ sdk }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entries = (sdk.dataset as any).palette({ includeSupplies: true }) as {
        r: number; g: number; b: number; a: number; supply?: number;
      }[];
      const colors: number[] = [];
      const cum: number[] = [];
      let total = 0;
      for (const e of entries) {
        if (e.a < 128) continue; // opaque only — the transparent background isn't a ring color
        total += Math.max(1, e.supply ?? 1);
        colors.push((e.r << 16) | (e.g << 8) | e.b);
        cum.push(total);
      }
      return { colors, cum, total };
    });
  }
  return palettePromise;
}

// Deterministic PRNG (mulberry32): one seed per tile, so a tile is stable across
// re-renders and Regenerate reshuffles by handing out fresh seeds.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function manhattan(a: number, b: number): number {
  return (
    Math.abs(((a >> 16) & 255) - ((b >> 16) & 255)) +
    Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) +
    Math.abs((a & 255) - (b & 255))
  );
}

function pickWeighted(pal: WeightedPalette, rng: () => number): number {
  const r = rng() * pal.total;
  let lo = 0;
  let hi = pal.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pal.cum[mid] <= r) lo = mid + 1;
    else hi = mid;
  }
  return pal.colors[lo];
}

export type SyntheticHomage = { svg: string; colorCount: number };

/** Render a synthetic homage from `seed`. `status` colours the ground; `sizePx` sets the
 *  intrinsic copy/paste resolution. */
export async function syntheticHomage(
  seed: number,
  opts: { status?: number; sizePx?: number } = {}
): Promise<SyntheticHomage> {
  const loaded = await getSdk();
  const pal = await getWeightedPalette();
  const rng = mulberry32(seed);
  // Ring count + proportions from a random punk's distilled structure (its colors discarded).
  const { cnts } = distill(pixels(loaded, Math.floor(rng() * 10_000)));
  const k = Math.max(1, cnts.length);
  // Novel colors, collection-weighted, kept separable (mirrors distill's MERGE_T).
  const colors: number[] = [];
  for (let guard = 0; colors.length < k && guard < k * 40; guard++) {
    const c = pickWeighted(pal, rng);
    if (!colors.some((x) => x === c || manhattan(x, c) < MERGE_T_SYNTH)) colors.push(c);
  }
  while (colors.length < k) colors.push(pickWeighted(pal, rng)); // palette too small to fill k
  const order = rings(colors, cnts.slice(0, colors.length));
  let s = svg(groundForStatus(opts.status ?? 0), order, false);
  if (opts.sizePx) s = atSize(s, opts.sizePx);
  return { svg: s, colorCount: colors.length };
}

function syntheticMeta(h: SyntheticHomage, status: number): TokenMeta {
  return {
    image: h.svg,
    attributes: [
      { trait_type: "Color Count", value: h.colorCount },
      { trait_type: "Status", value: STATUS_LABEL[status] ?? STATUS_LABEL[0] },
    ],
  };
}

/** Wall tile — a synthetic homage src. */
export function useSyntheticArt(seed: number, status = 0, sizePx?: number) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    syntheticHomage(seed, { status, sizePx })
      .then((h) => {
        if (!cancelled) setSrc(anySvgToSrc(h.svg));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [seed, status, sizePx]);
  return { src };
}

/** Detail overlay — synthetic homage src + minimal metadata (color count + status). */
export function useSyntheticSample(seed: number, status = 0, sizePx?: number) {
  const [state, setState] = useState<{ src?: string; meta?: TokenMeta; isLoading: boolean }>({ isLoading: true });
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, isLoading: true }));
    syntheticHomage(seed, { status, sizePx })
      .then((h) => {
        if (cancelled) return;
        setState({ src: anySvgToSrc(h.svg), meta: syntheticMeta(h, status), isLoading: false });
      })
      .catch(() => {
        if (!cancelled) setState({ isLoading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [seed, status, sizePx]);
  return state;
}
