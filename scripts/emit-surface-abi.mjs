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
emit({
  artifact: "DefaultRenderer.sol/DefaultRenderer.json",
  exportName: "defaultRendererAbi",
  outFiles: ["packages/abi/src/defaultRenderer.ts"],
});
// Bring-your-own generative renderer template (artists deploy their own, one
// per work; not a shared singleton). Published so tools can read/verify a
// deployed instance's work refs.
emit({
  artifact: "ScriptyRenderer.sol/ScriptyRenderer.json",
  exportName: "scriptyRendererAbi",
  outFiles: ["packages/abi/src/scriptyRenderer.ts"],
});

// Reference mint hooks (swappable mint-hook slot implementations).
emit({
  artifact: "AllowlistHook.sol/AllowlistHook.json",
  exportName: "allowlistHookAbi",
  outFiles: ["packages/abi/src/allowlistHook.ts"],
});
emit({
  artifact: "PerWalletCapHook.sol/PerWalletCapHook.json",
  exportName: "perWalletCapHookAbi",
  outFiles: ["packages/abi/src/perWalletCapHook.ts"],
});
emit({
  artifact: "HoldsSurfaceHook.sol/HoldsSurfaceHook.json",
  exportName: "holdsSurfaceHookAbi",
  outFiles: ["packages/abi/src/holdsSurfaceHook.ts"],
});
// Merkle allowlist + per-wallet cap composed into one hook (the two gates a
// real gated drop typically wants at once).
emit({
  artifact: "GateHook.sol/GateHook.json",
  exportName: "gateHookAbi",
  outFiles: ["packages/abi/src/gateHook.ts"],
});

// Render-land registry of static display assets (covers + captures).
emit({
  artifact: "RenderAssets.sol/RenderAssets.json",
  exportName: "renderAssetsAbi",
  outFiles: ["packages/abi/src/renderAssets.ts"],
});

// Swappable-slot interfaces (the third-party API surface implementers satisfy).
emit({
  artifact: "IMintHook.sol/IMintHook.json",
  exportName: "iMintHookAbi",
  outFiles: ["packages/abi/src/iMintHook.ts"],
});
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
