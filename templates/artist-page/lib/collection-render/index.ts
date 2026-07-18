// Vendored (partial) from the foundation monorepo's
// apps/web/src/lib/collection-render/. Do not let build.ts/types.ts drift
// from upstream; resolve.ts is a trimmed, inlined-imports variant — see its
// header comment for exactly what changed and why.
export { buildTokenHTML, buildContextJs, HEAD_STYLE_CONTENT } from "./build";
export { chainResolver, defaultGunzip } from "./resolve";
export { CODE_KIND } from "./types";
export type {
  BuildOptions,
  CodeKind,
  CodeRefLike,
  ContentResolver,
  GunzipRef,
  TokenData,
  WorkInput,
} from "./types";
