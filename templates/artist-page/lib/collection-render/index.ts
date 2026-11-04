// The parity render library, vendored (partial) from the PND monorepo's
// apps/web/src/lib/collection-render/. docs/injection-convention.md is the
// spec; the upstream library is the reference implementation. build.ts and
// types.ts are verbatim copies; resolve.ts is a trimmed, inlined-imports
// variant (see its header for exactly what changed and why).
//
// Not wired into a component yet: the recent-mints grid renders each token
// through its own tokenURI (any renderer, no parity source needed). This is
// here for an artist who wants a live in-page render of a generative work.
export { buildTokenHTML, buildContextJs, HEAD_STYLE_CONTENT } from "./build";
export { cachedChainResolver, chainResolver, defaultGunzip, fileKey } from "./resolve";
export { CODE_KIND } from "./types";
export type {
  BuildOptions,
  CodeKind,
  CodeRefLike,
  ContentResolver,
  GunzipRef,
  TokenContext,
  TokenData,
  WorkInput,
} from "./types";
