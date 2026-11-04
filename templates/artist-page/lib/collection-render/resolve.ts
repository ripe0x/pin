/**
 * VENDORED (partial) from the PND monorepo's
 * apps/web/src/lib/collection-render/resolve.ts. Upstream also exports
 * `bytesResolver`/`layeredResolver` for the studio's pre-upload preview; this
 * template only renders already-minted tokens from chain state, so only the
 * chain resolvers and `defaultGunzip` are vendored. Their logic is copied
 * verbatim; do not let it drift.
 *
 * Two changes from upstream, both required by the template's no-workspace-
 * imports rule (it is synced out to a standalone public repo):
 *   1. `scriptyStorageAbi` is inlined as `SCRIPTY_STORAGE_GET_CONTENT_ABI`
 *      (the one `getContent` fragment this resolver calls) instead of
 *      `import { scriptyStorageAbi } from "@pin/abi"`.
 *   2. `defaultGunzip` hardcodes the mainnet EthFS v2 FileStore instead of
 *      reading `ETHFS_V2_FILE_STORAGE` from `@pin/addresses`: the template is
 *      mainnet-only (see lib/rpc.ts), so it takes no chain id.
 *
 * Content resolvers for the parity builder. A resolver returns the exact
 * TEXT scripty would insert between the tag open/close: raw JS source for
 * Script refs, base64 text for ScriptGzip refs (the onchain storage
 * convention stores gzipped files pre-encoded).
 */

import { hexToBytes } from "viem";
import type { Address, PublicClient } from "viem";

import type { CodeRefLike, ContentResolver, GunzipRef } from "./types";

const utf8 = new TextDecoder();

// Inlined from packages/abi/src/scriptyStorage.ts — the single `getContent`
// fragment shared by ScriptyStorageV2, EthFS adapters, and any other
// IScriptyContractStorage-compatible store.
const SCRIPTY_STORAGE_GET_CONTENT_ABI = [
  {
    type: "function",
    name: "getContent",
    stateMutability: "view",
    inputs: [
      { name: "name", type: "string", internalType: "string" },
      { name: "data", type: "bytes", internalType: "bytes" },
    ],
    outputs: [{ name: "content", type: "bytes", internalType: "bytes" }],
  },
] as const;

/** `${store}:${name}` key for the in-memory cache. */
export function fileKey(ref: Pick<CodeRefLike, "store" | "name">): string {
  return `${ref.store.toLowerCase()}:${ref.name}`;
}

/**
 * Chain resolver: reads scripty-compatible storage (ScriptyStorageV2,
 * EthFS adapters, or any IScriptyContractStorage) via getContent. This is
 * exactly the read the onchain builder performs per tag.
 */
export function chainResolver(client: PublicClient): ContentResolver {
  return async (ref) => {
    const content = await client.readContract({
      address: ref.store,
      abi: SCRIPTY_STORAGE_GET_CONTENT_ABI,
      functionName: "getContent",
      args: [ref.name, "0x"],
    });
    return utf8.decode(hexToBytes(content));
  };
}

// Onchain file content is immutable per (store, name), so one module-level
// cache serves every renderer on a page: the ~230KB p5 dependency is fetched
// once and shared across any number of hero/grid iframes.
const contentCache = new Map<string, Promise<string>>();

/**
 * Chain resolver with a shared in-memory content cache. Use this for any
 * surface rendering multiple tokens of the same work (hero + grids); the
 * dependency bytes are fetched once per session.
 */
export function cachedChainResolver(client: PublicClient): ContentResolver {
  const inner = chainResolver(client);
  return (ref) => {
    const key = fileKey(ref);
    let hit = contentCache.get(key);
    if (!hit) {
      hit = inner(ref);
      contentCache.set(key, hit);
      hit.catch(() => contentCache.delete(key));
    }
    return hit;
  };
}

// Mainnet EthFS v2 FileStore — vendored from
// packages/addresses/src/index.ts's ETHFS_V2_FILE_STORAGE[MAINNET_CHAIN_ID].
const ETHFS_V2_FILE_STORAGE_MAINNET: Address =
  "0x8FAA1AAb9DA8c75917C43Fb24fDdb513edDC3245";

/**
 * The canonical gunzip helper: EthFS v2's `gunzipScripts-0.0.1.js`, the
 * file the convention's assembly appends when any tag is gzipped (a
 * renderer-level setting, not per work). A renderer that uses a different
 * helper must be read for its own store/file instead.
 */
export function defaultGunzip(): GunzipRef {
  return {
    store: ETHFS_V2_FILE_STORAGE_MAINNET,
    name: "gunzipScripts-0.0.1.js",
  };
}

export type { CodeRefLike };
