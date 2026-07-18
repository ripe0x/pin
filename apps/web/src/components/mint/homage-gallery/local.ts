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

export type LocalHomage = { svg: string; colorCount: number; type: string; accessories: string[] };

/** Render a punk's homage fully locally. `status` colours the ground (default 0 = not for sale). */
export async function localHomage(id: number, opts: { status?: number; circle?: boolean } = {}): Promise<LocalHomage> {
  const loaded = await getSdk();
  const img = pixels(loaded, id);
  const { cols, cnts } = distill(img);
  const svgStr = svg(groundForStatus(opts.status ?? 0), rings(cols, cnts), opts.circle ?? false);
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

/** Focus/reveal overlays — src + full trait metadata, rendered locally. */
export function useLocalSample(id: number, status = 0) {
  const [state, setState] = useState<{ src?: string; meta?: TokenMeta; isLoading: boolean }>({ isLoading: true });
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, isLoading: true }));
    localHomage(id, { status })
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
  }, [id, status]);
  return state;
}

/** Wall tile — just the classic src, rendered locally. */
export function useLocalArt(id: number, status = 0) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    localHomage(id, { status })
      .then((h) => {
        if (!cancelled) setSrc(anySvgToSrc(h.svg));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, status]);
  return { src };
}
