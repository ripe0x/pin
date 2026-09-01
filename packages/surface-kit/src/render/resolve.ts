import { hexToBytes, type Address, type PublicClient } from "viem"
import { scriptyStorageAbi } from "@pin/abi"
import { ETHFS_V2_FILE_STORAGE, getAddressOrNull } from "@pin/addresses"
import { CODE_KIND, type CodeRefLike, type ContentResolver, type GunzipRef } from "./types.ts"

const utf8 = new TextDecoder()
const contentCache = new Map<string, Promise<string>>()

export function fileKey(ref: Pick<CodeRefLike, "store" | "name">): string {
  return `${ref.store.toLowerCase()}:${ref.name}`
}

export function bytesResolver(files: Map<string, string | Uint8Array>): ContentResolver {
  return async (ref) => {
    const content = files.get(fileKey(ref)) ?? files.get(ref.name)
    if (content === undefined) throw new Error(`collection-render: no local content for ${ref.name}`)
    return typeof content === "string" ? content : utf8.decode(content)
  }
}

export function chainResolver(client: PublicClient): ContentResolver {
  return async (ref) => {
    const content = await client.readContract({
      address: ref.store,
      abi: scriptyStorageAbi,
      functionName: "getContent",
      args: [ref.name, "0x"],
    })
    return utf8.decode(hexToBytes(content))
  }
}

export function cachedChainResolver(client: PublicClient): ContentResolver {
  const inner = chainResolver(client)
  return (ref) => {
    const key = fileKey(ref)
    let cached = contentCache.get(key)
    if (!cached) {
      cached = inner(ref)
      contentCache.set(key, cached)
      cached.catch(() => contentCache.delete(key))
    }
    return cached
  }
}

export function layeredResolver(
  files: Map<string, string | Uint8Array>,
  client: PublicClient,
): ContentResolver {
  const local = bytesResolver(files)
  const chain = chainResolver(client)
  return async (ref) => {
    try {
      return await local(ref)
    } catch {
      return chain(ref)
    }
  }
}

export function defaultGunzip(chainId: number): GunzipRef {
  const store = getAddressOrNull(ETHFS_V2_FILE_STORAGE, chainId) ?? getAddressOrNull(ETHFS_V2_FILE_STORAGE, 1)
  if (!store) throw new Error("collection-render: EthFS address unavailable")
  return { store: store as Address, name: "gunzipScripts-0.0.1.js" }
}

export function memoryResolver(entries: Iterable<readonly [CodeRefLike, string]>): ContentResolver {
  const files = new Map<string, string>()
  for (const [ref, content] of entries) files.set(fileKey(ref), content)
  return bytesResolver(files)
}

export function plainScriptRef(store: Address, name: string): CodeRefLike {
  return { store, name, kind: CODE_KIND.Script }
}
