/**
 * VENDORED, byte-for-byte, from the foundation monorepo's
 * apps/web/src/lib/collection-render/build.ts. Do not edit the logic below
 * independently of upstream — this file must not drift from it. Re-vendor by
 * copying the upstream file over this one verbatim (no import changes are
 * needed here; this file has no `@pin/*` imports).
 *
 * The parity document builder: reproduces, byte for byte, the HTML that
 * GenerativeRenderer.sol emits through ScriptyBuilderV2 (before the
 * onchain whole-document base64 encoding).
 *
 * Emission facts, verified against scripty.sol ScriptyCore.sol and
 * contracts/src/collection/renderers/GenerativeRenderer.sol:
 *   - document: <html><head>[head tags]</head><body>[body tags]</body></html>
 *     (no doctype, no whitespace between tags)
 *   - HTMLTagType.script: <script>CONTENT</script>
 *   - HTMLTagType.scriptGZIPBase64DataURI:
 *     <script type="text/javascript+gzip" src="data:text/javascript;base64,CONTENT"></script>
 *     where CONTENT is the stored bytes VERBATIM (gzipped files are stored
 *     as base64 text onchain; scripty never re-encodes tag content)
 *   - body order: gunzip helper (only when any following tag is gzipped),
 *     dependencies, the tokenData injection, artist code
 *
 * Divergence between this file and the onchain renderer is a bug by
 * definition; the fork e2e (web plan D8) asserts equality.
 */

import { CODE_KIND } from "./types";
import type {
  BuildOptions,
  CodeRefLike,
  ContentResolver,
  TokenData,
  WorkInput,
} from "./types";

/** GenerativeRenderer's single head tag, exact content. */
export const HEAD_STYLE_CONTENT =
  "html,body{margin:0;padding:0;height:100%;overflow:hidden}canvas{display:block}";

/**
 * The tokenData injection, exactly matching GenerativeRenderer._contextJs:
 * field order, string vs number types, lowercase hex, trailing semicolon.
 */
export function buildContextJs(t: TokenData): string {
  return (
    'window.tokenData={"hash":"' +
    t.hash.toLowerCase() +
    '","tokenId":"' +
    t.tokenId +
    '","mintIndex":' +
    String(t.mintIndex) +
    ',"mintBlock":' +
    String(t.mintBlock) +
    ',"collection":"' +
    t.collection.toLowerCase() +
    '","chainId":' +
    String(t.chainId) +
    ',"version":' +
    String(t.version) +
    "};"
  );
}

function scriptTag(content: string): string {
  return "<script>" + content + "</script>";
}

function gzipTag(base64Content: string): string {
  return (
    '<script type="text/javascript+gzip" src="data:text/javascript;base64,' +
    base64Content +
    '"></script>'
  );
}

function fileTag(ref: CodeRefLike, content: string): string {
  return ref.kind === CODE_KIND.ScriptGzip ? gzipTag(content) : scriptTag(content);
}

function anyGzip(refs: CodeRefLike[]): boolean {
  return refs.some((r) => r.kind === CODE_KIND.ScriptGzip);
}

/**
 * Build the full token document. Content is fetched through `resolve`
 * (chain reads in production surfaces, in-memory bytes in the studio
 * before upload); fetches run in parallel, assembly order is fixed.
 */
export async function buildTokenHTML(
  work: WorkInput,
  tokenData: TokenData,
  resolve: ContentResolver,
  opts: BuildOptions,
): Promise<string> {
  if (work.code.length === 0) {
    throw new Error("collection-render: work has no code refs");
  }
  const needsGunzip = anyGzip(work.deps) || anyGzip(work.code);

  const gunzipPromise = needsGunzip
    ? resolve({ ...opts.gunzip, kind: CODE_KIND.Script })
    : Promise.resolve("");
  const depContents = Promise.all(work.deps.map((d) => resolve(d)));
  const codeContents = Promise.all(work.code.map((c) => resolve(c)));

  const [gunzip, deps, code] = await Promise.all([
    gunzipPromise,
    depContents,
    codeContents,
  ]);

  const body: string[] = [];
  if (needsGunzip) body.push(scriptTag(gunzip));
  work.deps.forEach((ref, i) => body.push(fileTag(ref, deps[i])));
  body.push(scriptTag(buildContextJs(tokenData)));
  work.code.forEach((ref, i) => body.push(fileTag(ref, code[i])));

  return (
    "<html><head>" +
    "<style>" +
    HEAD_STYLE_CONTENT +
    "</style>" +
    "</head><body>" +
    body.join("") +
    "</body></html>"
  );
}
