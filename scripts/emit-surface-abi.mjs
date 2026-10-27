#!/usr/bin/env node
/**
 * Extract Sovereign Surface ABIs from forge build artifacts and write them
 * as TypeScript modules under packages/abi/src.
 *
 * Run after any change to the Solidity contracts:
 *   cd contracts && forge build
 *   node scripts/emit-surface-abi.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// `outFiles` are repo-relative destinations. The indexer imports a couple of
// these ABIs from its own abis/ directory (ponder.config.ts), so those are
// emitted to BOTH packages/abi/src and apps/indexer/abis to keep the two copies
// from silently drifting apart the way they did before.
function emit({ artifact, exportName, outFiles }) {
  const artifactPath = resolve(repoRoot, "contracts/out", artifact);
  const json = JSON.parse(readFileSync(artifactPath, "utf8"));
  const abi = json.abi;
  const body = `// Auto-extracted from contracts/out/${artifact}.\n// Re-run: node scripts/emit-surface-abi.mjs\nexport const ${exportName} = ${JSON.stringify(abi, null, 2)} as const;\n`;
  for (const rel of outFiles) {
    const out = resolve(repoRoot, rel);
    writeFileSync(out, body);
    console.log(`Wrote ${out} (${abi.length} items)`);
  }
}

emit({
  artifact: "Surface.sol/Surface.json",
  exportName: "surfaceAbi",
  outFiles: ["packages/abi/src/surface.ts", "apps/indexer/abis/Surface.ts"],
});
// The pooled final. Shares the SurfaceCore surface with Surface but its
// mint entrypoint is mintToId (the minter chooses ids), not mint/mintTo.
// Published for integrators building against pooled surfaces.
emit({
  artifact: "PooledSurface.sol/PooledSurface.json",
  exportName: "pooledSurfaceAbi",
  outFiles: ["packages/abi/src/pooledSurface.ts"],
});
emit({
  artifact: "SurfaceFactory.sol/SurfaceFactory.json",
  exportName: "surfaceFactoryAbi",
  outFiles: [
    "packages/abi/src/surfaceFactory.ts",
    "apps/indexer/abis/SurfaceFactory.ts",
  ],
});
// Canonical fixed-price/referral minter (Phase 2/3): one EIP-1167 clone per
// collection, cloned and wired by SurfaceFactory.createSurface. Emitted to
// both packages/abi/src and apps/indexer/abis like Surface/SurfaceFactory
// above, since the indexer binds Sold/ReferralPaid per clone via the
// factory() child-contract pattern keyed off SurfaceCreated's minter field.
emit({
  artifact: "FixedPriceMinter.sol/FixedPriceMinter.json",
  exportName: "fixedPriceMinterAbi",
  outFiles: [
    "packages/abi/src/fixedPriceMinter.ts",
    "apps/indexer/abis/FixedPriceMinter.ts",
  ],
});
// Swappable-slot interfaces (the third-party API surface implementers satisfy).
emit({
  artifact: "IPriceStrategy.sol/IPriceStrategy.json",
  exportName: "iPriceStrategyAbi",
  outFiles: ["packages/abi/src/iPriceStrategy.ts"],
});
emit({
  artifact: "IRenderer.sol/IRenderer.json",
  exportName: "iRendererAbi",
  outFiles: ["packages/abi/src/iRenderer.ts"],
});
// ISurfaceView is declared in IRenderer.sol; it is the core read surface
// renderers, price strategies, and minters consume.
emit({
  artifact: "IRenderer.sol/ISurfaceView.json",
  exportName: "iSurfaceViewAbi",
  outFiles: ["packages/abi/src/iSurfaceView.ts"],
});
// OPTIONAL renderer extension: render what a token WOULD look like for a
// caller-supplied seed, without any token existing (previewURI).
emit({
  artifact: "IPreviewRenderer.sol/IPreviewRenderer.json",
  exportName: "iPreviewRendererAbi",
  outFiles: ["packages/abi/src/iPreviewRenderer.ts"],
});

// DefaultRenderer, ScriptyRenderer, RenderAssets and the first Surface v2
// (SurfaceV2, SurfaceFactoryV2, FixedPriceMinterV2) no longer have sources in
// the repo. Their packages/abi files are frozen as last emitted (they still
// describe the Sepolia deploys the web app reads) and are not re-emitted.

// Surface v2 primitives (docs/pnd-surface-v2-design.md). The token shares
// its contract name with the v1 Surface, so forge writes it under out/v2/.
// Not emitted to apps/indexer/abis (indexer v2 support ships separately).
emit({
  artifact: "v2/Surface.sol/Surface.json",
  exportName: "surfaceTokenV2Abi",
  outFiles: ["packages/abi/src/surfaceTokenV2.ts"],
});
emit({
  artifact: "FixedPriceSale.sol/FixedPriceSale.json",
  exportName: "fixedPriceSaleAbi",
  outFiles: ["packages/abi/src/fixedPriceSale.ts"],
});
emit({
  artifact: "AllowlistGate.sol/AllowlistGate.json",
  exportName: "allowlistGateAbi",
  outFiles: ["packages/abi/src/allowlistGate.ts"],
});
emit({
  artifact: "CloneFactory.sol/CloneFactory.json",
  exportName: "cloneFactoryAbi",
  outFiles: ["packages/abi/src/cloneFactory.ts"],
});
emit({
  artifact: "Launcher.sol/Launcher.json",
  exportName: "launcherAbi",
  outFiles: ["packages/abi/src/launcher.ts"],
});
