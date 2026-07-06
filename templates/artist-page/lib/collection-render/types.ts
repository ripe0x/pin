/**
 * VENDORED, byte-for-byte, from the foundation monorepo's
 * apps/web/src/lib/collection-render/types.ts. Do not edit the logic below
 * independently of upstream — this file must not drift from it. Re-vendor by
 * copying the upstream file over this one verbatim (no import changes are
 * needed here; this file has no `@pin/*` imports).
 *
 * Shared types for the parity render library: the offchain implementation
 * of docs/injection-convention.md v1.
 *
 * The builder in ./build.ts must produce, byte for byte, the document the
 * onchain GenerativeRenderer emits (before its whole-document base64
 * encoding). Anything that would make the two diverge belongs nowhere in
 * this module.
 */

import type { Address } from "viem";

/** Mirrors CollectionTypes.sol CodeKind. */
export const CODE_KIND = {
  Script: 0,
  ScriptGzip: 1,
} as const;
export type CodeKind = (typeof CODE_KIND)[keyof typeof CODE_KIND];

/** Mirrors CollectionTypes.sol CodeRef. */
export type CodeRefLike = {
  store: Address;
  name: string;
  kind: CodeKind;
};

/** The subset of WorkConfig the document builder consumes. */
export type WorkInput = {
  code: CodeRefLike[];
  deps: CodeRefLike[];
  injectionVersion: number;
};

/**
 * The injected context object, exactly as GenerativeRenderer emits it.
 * hash and tokenId are Art Blocks compatible; see the convention doc.
 */
export type TokenData = {
  /** 0x + 64 lowercase hex (the tokenSeed). */
  hash: string;
  /** Decimal string. */
  tokenId: string;
  mintIndex: number;
  mintBlock: number;
  /** 0x + 40 lowercase hex. */
  collection: string;
  chainId: number;
  /** Echoes WorkConfig.injectionVersion. */
  version: number;
};

/**
 * Resolves a stored file's content to the exact text scripty would insert
 * verbatim between the tag open/close. Gzipped files are stored as base64
 * TEXT onchain (scripty inserts stored bytes without encoding them), so a
 * resolver returns that base64 text for ScriptGzip refs and raw JS source
 * for Script refs.
 */
export type ContentResolver = (ref: CodeRefLike) => Promise<string>;

/** Where the gunzip helper lives (a renderer immutable, not WorkConfig). */
export type GunzipRef = {
  store: Address;
  name: string;
};

export type BuildOptions = {
  gunzip: GunzipRef;
};
