// SVG + token-metadata helpers for the Homage gallery — the subset of the
// Homage site's lib/svg.ts the wall actually uses (port source:
// permanence origin/master:web/lib/svg.ts).

/// Render an SVG string safely as an <img> source (no script execution).
export const svgToSrc = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

/// Turn renderer/punk SVG output into a safe <img> src.
/// - renderer renderSVG/previewSVG return a bare `<svg…>` string.
/// - CryptoPunksData.punkImageSvg returns `data:image/svg+xml;utf8,<svg…>` with the
///   body unescaped — raw `#`/`"` truncate or break it in an <img>, so re-encode it.
export const anySvgToSrc = (s: string) => {
  const utf8Prefix = "data:image/svg+xml;utf8,";
  if (s.startsWith(utf8Prefix)) return svgToSrc(s.slice(utf8Prefix.length));
  if (s.startsWith("data:")) return s; // already base64 / otherwise complete
  return svgToSrc(s);
};

export type Trait = { trait_type: string; value: string | number; display_type?: string; href?: string };
export type TokenMeta = {
  name?: string;
  description?: string;
  image?: string;
  attributes?: Trait[];
};

export const accessories = (m: TokenMeta | null) =>
  (m?.attributes ?? []).filter((t) => t.trait_type === "Punk Accessory").map((t) => String(t.value));

export const trait = (m: TokenMeta | null, type: string) =>
  (m?.attributes ?? []).find((t) => t.trait_type === type)?.value;
