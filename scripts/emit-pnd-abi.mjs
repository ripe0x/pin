#!/usr/bin/env node
/**
 * Extract PND auction contract ABIs from forge build artifacts and write them
 * as TypeScript modules under packages/abi/src.
 *
 * Run after any change to the Solidity contracts:
 *   cd contracts && forge build
 *   node scripts/emit-pnd-abi.mjs
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
  const body = `// Auto-extracted from contracts/out/${artifact}.\n// Re-run: node scripts/emit-pnd-abi.mjs\nexport const ${exportName} = ${JSON.stringify(abi, null, 2)} as const;\n`;
  writeFileSync(out, body);
  console.log(`Wrote ${out} (${abi.length} items)`);
}

emit({
  artifact: "PndAuctionHouse.sol/PndAuctionHouse.json",
  exportName: "pndAuctionHouseAbi",
  outFile: "pndAuctionHouse.ts",
});
emit({
  artifact: "PndAuctionHouseFactory.sol/PndAuctionHouseFactory.json",
  exportName: "pndAuctionHouseFactoryAbi",
  outFile: "pndAuctionHouseFactory.ts",
});
