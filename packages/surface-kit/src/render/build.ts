import { CODE_KIND } from "./types.ts"
import type { BuildOptions, CodeRefLike, ContentResolver, TokenData, WorkInput } from "./types.ts"

export const HEAD_STYLE_CONTENT =
  "html,body{margin:0;padding:0;height:100%;overflow:hidden}canvas{display:block}"

export function buildContextJs(token: TokenData): string {
  return (
    'window.tokenData={"hash":"' +
    token.hash.toLowerCase() +
    '","tokenId":"' +
    token.tokenId +
    '","collection":"' +
    token.collection.toLowerCase() +
    '","chainId":' +
    String(token.chainId) +
    ',"version":' +
    String(token.version) +
    ',"context":"' +
    token.context +
    '"};'
  )
}

function scriptTag(content: string): string {
  return `<script>${content}</script>`
}

function gzipTag(content: string): string {
  return `<script type="text/javascript+gzip" src="data:text/javascript;base64,${content}"></script>`
}

function base64ScriptTag(content: string): string {
  return `<script src="data:text/javascript;base64,${content}"></script>`
}

function fileTag(ref: CodeRefLike, content: string): string {
  return ref.kind === CODE_KIND.ScriptGzip ? gzipTag(content) : scriptTag(content)
}

export async function buildTokenHTML(
  work: WorkInput,
  tokenData: TokenData,
  resolve: ContentResolver,
  options: BuildOptions,
): Promise<string> {
  if (work.code.length === 0) throw new Error("collection-render: work has no code refs")
  const needsGunzip = [...work.deps, ...work.code].some((ref) => ref.kind === CODE_KIND.ScriptGzip)
  const [gunzip, dependencies, code] = await Promise.all([
    needsGunzip ? resolve({ ...options.gunzip, kind: CODE_KIND.Script }) : Promise.resolve(""),
    Promise.all(work.deps.map((ref) => resolve(ref))),
    Promise.all(work.code.map((ref) => resolve(ref))),
  ])
  const body: string[] = []
  work.deps.forEach((ref, index) => body.push(fileTag(ref, dependencies[index]!)))
  body.push(scriptTag(buildContextJs(tokenData)))
  work.code.forEach((ref, index) => body.push(fileTag(ref, code[index]!)))
  if (needsGunzip) body.push(base64ScriptTag(gunzip))
  return `<html><head><style>${HEAD_STYLE_CONTENT}</style></head><body>${body.join("")}</body></html>`
}
