import type { Address } from "viem"

export const CODE_KIND = { Script: 0, ScriptGzip: 1 } as const
export type CodeKind = (typeof CODE_KIND)[keyof typeof CODE_KIND]

export type CodeRefLike = { store: Address; name: string; kind: CodeKind }
export type WorkInput = { code: CodeRefLike[]; deps: CodeRefLike[]; injectionVersion: number }
export type TokenContext = "token" | "preview" | "capture"
export type TokenData = {
  hash: string
  tokenId: string
  collection: string
  chainId: number
  version: number
  context: TokenContext
}
export type ContentResolver = (ref: CodeRefLike) => Promise<string>
export type GunzipRef = { store: Address; name: string }
export type BuildOptions = { gunzip: GunzipRef }
