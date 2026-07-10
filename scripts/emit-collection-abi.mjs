#!/usr/bin/env node
/**
 * Extract Sovereign Collection ABIs from forge build artifacts and write them
 * as TypeScript modules under packages/abi/src.
 *
 * Run after any change to the Solidity contracts:
 *   cd contracts && forge build
 *   node scripts/emit-collection-abi.mjs
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
  const body = `// Auto-extracted from contracts/out/${artifact}.\n// Re-run: node scripts/emit-collection-abi.mjs\nexport const ${exportName} = ${JSON.stringify(abi, null, 2)} as const;\n`;
  for (const rel of outFiles) {
    const out = resolve(repoRoot, rel);
    writeFileSync(out, body);
    console.log(`Wrote ${out} (${abi.length} items)`);
  }
}

emit({
  artifact: "Collection.sol/Collection.json",
  exportName: "collectionAbi",
  outFiles: ["packages/abi/src/collection.ts", "apps/indexer/abis/Collection.ts"],
});
emit({
  artifact: "CollectionFactory.sol/CollectionFactory.json",
  exportName: "collectionFactoryAbi",
  outFiles: [
    "packages/abi/src/collectionFactory.ts",
    "apps/indexer/abis/CollectionFactory.ts",
  ],
});
emit({
  artifact: "GenerativeRenderer.sol/GenerativeRenderer.json",
  exportName: "generativeRendererAbi",
  outFiles: ["packages/abi/src/generativeRenderer.ts"],
});
emit({
  artifact: "DefaultRenderer.sol/DefaultRenderer.json",
  exportName: "defaultRendererAbi",
  outFiles: ["packages/abi/src/defaultRenderer.ts"],
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
  artifact: "HoldsCollectionHook.sol/HoldsCollectionHook.json",
  exportName: "holdsCollectionHookAbi",
  outFiles: ["packages/abi/src/holdsCollectionHook.ts"],
});

// Render-land registries (work configs + static display assets).
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
// ICollectionView is declared in IRenderer.sol; it is the core read surface
// renderers, price strategies, and minters consume.
emit({
  artifact: "IRenderer.sol/ICollectionView.json",
  exportName: "iCollectionViewAbi",
  outFiles: ["packages/abi/src/iCollectionView.ts"],
});
