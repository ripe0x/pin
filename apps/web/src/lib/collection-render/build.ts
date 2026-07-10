/**
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
 *   - body order: dependencies, the tokenData injection, artist code,
 *     gunzip helper LAST (it replaces the gzip tags that precede it)
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
    '","collection":"' +
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

function b64ScriptTag(base64Content: string): string {
  return (
    '<script src="data:text/javascript;base64,' + base64Content + '"></script>'
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

  // Order per the convention: deps, context, code, gunzip helper LAST.
  // The helper decompresses by scanning the gzip tags that PRECEDE it and
  // replacing each with an executing script tag; placed first it finds
  // nothing and gzipped libraries never execute.
  const body: string[] = [];
  work.deps.forEach((ref, i) => body.push(fileTag(ref, deps[i])));
  body.push(scriptTag(buildContextJs(tokenData)));
  work.code.forEach((ref, i) => body.push(fileTag(ref, code[i])));
  // The gunzip helper is stored as base64 text on EthFS (its data-URI
  // design), so it ships as a base64 data-URI script src, never inlined.
  if (needsGunzip) body.push(b64ScriptTag(gunzip));

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
