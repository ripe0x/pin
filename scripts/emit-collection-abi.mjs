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

function emit({ artifact, exportName, outFile }) {
  const artifactPath = resolve(repoRoot, "contracts/out", artifact);
  const json = JSON.parse(readFileSync(artifactPath, "utf8"));
  const abi = json.abi;
  const out = resolve(repoRoot, "packages/abi/src", outFile);
  const body = `// Auto-extracted from contracts/out/${artifact}.\n// Re-run: node scripts/emit-collection-abi.mjs\nexport const ${exportName} = ${JSON.stringify(abi, null, 2)} as const;\n`;
  writeFileSync(out, body);
  console.log(`Wrote ${out} (${abi.length} items)`);
}

emit({
  artifact: "Collection.sol/Collection.json",
  exportName: "collectionAbi",
  outFile: "collection.ts",
});
emit({
  artifact: "CollectionFactory.sol/CollectionFactory.json",
  exportName: "collectionFactoryAbi",
  outFile: "collectionFactory.ts",
});
emit({
  artifact: "Attribution.sol/Attribution.json",
  exportName: "attributionAbi",
  outFile: "attribution.ts",
});
emit({
  artifact: "GenerativeRenderer.sol/GenerativeRenderer.json",
  exportName: "generativeRendererAbi",
  outFile: "generativeRenderer.ts",
});
emit({
  artifact: "DefaultRenderer.sol/DefaultRenderer.json",
  exportName: "defaultRendererAbi",
  outFile: "defaultRenderer.ts",
});
