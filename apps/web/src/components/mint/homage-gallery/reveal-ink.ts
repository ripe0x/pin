// Ground extraction + contrast ink for the reveal overlay — the two pieces of
// the Homage site's lib/homageGeom.ts (parseHomage's ground pick) and
// lib/color.ts (luminance/inkVarsFor) the gallery needs (port source:
// permanence origin/master).

import type { CSSProperties } from "react";

/**
 * The ground fill of a homage SVG (bare markup or a data URI, base64 or
 * utf8) — the renderer emits the ground as the one full-canvas rect with no
 * x/y. Null when nothing parses.
 */
export function groundFromSrc(src: string): string | null {
  let svg = src;
  const b = src.indexOf(";base64,");
  const u = src.indexOf(";utf8,");
  if (b >= 0) {
    try {
      svg = atob(src.slice(b + 8));
    } catch {
      return null;
    }
  } else if (u >= 0) {
    svg = decodeURIComponent(src.slice(u + 6));
  }
  const m = svg.match(/<rect\s+width="\d+"\s+height="\d+"\s+fill="(#[0-9a-fA-F]{3,8})"\s*\/>/);
  return m ? m[1] : null;
}

/** Relative luminance of a "#rrggbb" (sRGB linearized). */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** Overlay ink CSS vars for text sitting ON an arbitrary ground color — light ink on dark
 *  grounds, dark on pale ones. Used by the reveal overlay, whose background is the drawn
 *  work's own (status) ground. */
export function inkVarsFor(bg: string): CSSProperties {
  const dark = luminance(bg) < 0.35;
  return (
    dark
      ? { "--ink": "#f4f4f2", "--dim": "rgba(244,244,242,0.68)", "--faint": "rgba(244,244,242,0.46)", "--line": "rgba(244,244,242,0.28)" }
      : { "--ink": "#121214", "--dim": "rgba(18,18,20,0.68)", "--faint": "rgba(18,18,20,0.5)", "--line": "rgba(18,18,20,0.26)" }
  ) as CSSProperties;
}
