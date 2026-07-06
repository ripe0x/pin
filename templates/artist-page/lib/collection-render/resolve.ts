/**
 * VENDORED (partial), from the foundation monorepo's
 * apps/web/src/lib/collection-render/resolve.ts. The upstream file also
 * exports `bytesResolver`/`layeredResolver` for the studio's pre-upload
 * preview flow; this template only ever renders already-minted tokens from
 * chain state, so only `chainResolver` + `defaultGunzip` are vendored here.
 * The logic in both is copied verbatim from upstream — do not let it drift.
 *
 * Two changes from upstream, both required by this template's no-workspace-
 * imports rule (everything under templates/artist-page/ must vendor its own
 * copies rather than import `@pin/*`, since the template is synced out to a
 * standalone public repo — see lib/abi/index.ts and lib/config.ts for the
 * same pattern):
 *   1. `scriptyStorageAbi` is inlined below as `SCRIPTY_STORAGE_GET_CONTENT_ABI`
 *      (just the one `getContent` fragment this resolver calls), instead of
 *      `import { scriptyStorageAbi } from "@pin/abi"`.
 *   2. `defaultGunzip` hardcodes the mainnet EthFS v2 FileStore address
 *      instead of `import { ETHFS_V2_FILE_STORAGE, getAddress } from
 *      "@pin/addresses"` — this template is mainnet-only (see lib/rpc.ts),
 *      so there's no multi-chain table to look up.
 *
 * Content resolvers for the parity builder.
 *
 * A resolver returns the exact TEXT scripty would insert between the tag
 * open/close: raw JS source for Script refs, base64 text for ScriptGzip
 * refs (the onchain storage convention stores gzipped files pre-encoded).
 */

import { hexToBytes } from "viem";
import type { Address, PublicClient } from "viem";

import type { CodeRefLike, ContentResolver, GunzipRef } from "./types";

const utf8 = new TextDecoder();

// Inlined from packages/abi/src/scriptyStorage.ts — the single `getContent`
// fragment shared by ScriptyStorageV2, EthFS adapters, and any other
// IScriptyContractStorage-compatible store. Keep in sync with upstream if
// the fragment's shape ever changes.
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

// Mainnet EthFS v2 FileStore — vendored from
// packages/addresses/src/index.ts's ETHFS_V2_FILE_STORAGE[MAINNET_CHAIN_ID].
// This template is mainnet-only (see lib/rpc.ts), so there's no per-chain
// table here, just the one address.
const ETHFS_V2_FILE_STORAGE_MAINNET: Address =
  "0x8FAA1AAb9DA8c75917C43Fb24fDdb513edDC3245";

/**
 * The canonical gunzip helper (a GenerativeRenderer constructor immutable,
 * not part of WorkConfig). Overridable per collection by reading the
 * renderer's own gunzipStore()/gunzipFile() when it ever differs — this
 * default matches every collection deployed with the stock GenerativeRenderer.
 */
export function defaultGunzip(): GunzipRef {
  return {
    store: ETHFS_V2_FILE_STORAGE_MAINNET,
    name: "gunzipScripts-0.0.1.js",
  };
}

export type { CodeRefLike };
