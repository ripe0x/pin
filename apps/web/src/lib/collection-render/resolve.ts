/**
 * Content resolvers for the parity builder.
 *
 * A resolver returns the exact TEXT scripty would insert between the tag
 * open/close: raw JS source for Script refs, base64 text for ScriptGzip
 * refs (the onchain storage convention stores gzipped files pre-encoded).
 */

import { hexToBytes } from "viem";
import type { Address, PublicClient } from "viem";
import { scriptyStorageAbi } from "@pin/abi";
import { ETHFS_V2_FILE_STORAGE, getAddressOrNull } from "@pin/addresses";

import type { CodeRefLike, ContentResolver, GunzipRef } from "./types";

const utf8 = new TextDecoder();

/** `${store}:${name}` key for the in-memory resolver. */
export function fileKey(ref: Pick<CodeRefLike, "store" | "name">): string {
  return `${ref.store.toLowerCase()}:${ref.name}`;
}

/**
 * Studio-preview resolver: content that has not been uploaded yet, keyed
 * by fileKey(). Values are the exact insert text (see module doc).
 */
export function bytesResolver(files: Map<string, string | Uint8Array>): ContentResolver {
  return async (ref) => {
    const hit = files.get(fileKey(ref)) ?? files.get(ref.name);
    if (hit === undefined) {
      throw new Error(`collection-render: no local content for ${ref.name}`);
    }
    return typeof hit === "string" ? hit : utf8.decode(hit);
  };
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
      abi: scriptyStorageAbi,
      functionName: "getContent",
      args: [ref.name, "0x"],
    });
    return utf8.decode(hexToBytes(content));
  };
}

/**
 * Layered resolver: local bytes win (files mid-upload in the studio),
 * everything else falls through to the chain.
 */
export function layeredResolver(
  files: Map<string, string | Uint8Array>,
  client: PublicClient,
): ContentResolver {
  const local = bytesResolver(files);
  const chain = chainResolver(client);
  return async (ref) => {
    try {
      return await local(ref);
    } catch {
      return chain(ref);
    }
  };
}

/**
 * The canonical gunzip helper (a GenerativeRenderer constructor immutable,
 * not part of WorkConfig). Chain-agnostic singleton: dev chains fork
 * mainnet, so the mainnet entry is valid there and serves as the fallback
 * for any chain id without its own entry. Overridable per collection by
 * reading the renderer's own gunzipStore()/gunzipFile() when it differs.
 */
export function defaultGunzip(chainId: number): GunzipRef {
  const store =
    getAddressOrNull(ETHFS_V2_FILE_STORAGE, chainId) ?? getAddressOrNull(ETHFS_V2_FILE_STORAGE, 1);
  if (!store) throw new Error("collection-render: EthFS address unavailable");
  return {
    store: store as Address,
    name: "gunzipScripts-0.0.1.js",
  };
}
