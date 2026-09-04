#!/usr/bin/env node
/**
 * Extract Sovereign Auction House ABIs from forge build artifacts and write them
 * as TypeScript modules under packages/abi/src.
 *
 * Run after any change to the Solidity contracts:
 *   cd contracts && forge build
 *   node scripts/emit-sovereign-abi.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function emit({ artifact, exportName, outFile, indexerFile }) {
  const artifactPath = resolve(repoRoot, "contracts/out", artifact);
  const json = JSON.parse(readFileSync(artifactPath, "utf8"));
  const abi = json.abi;
  const body = `// Auto-extracted from contracts/out/${artifact}.\n// Re-run: node scripts/emit-sovereign-abi.mjs\nexport const ${exportName} = ${JSON.stringify(abi, null, 2)} as const;\n`;
  const out = resolve(repoRoot, "packages/abi/src", outFile);
  writeFileSync(out, body);
  console.log(`Wrote ${out} (${abi.length} items)`);
  if (indexerFile) {
    const indexerOut = resolve(repoRoot, "apps/indexer/abis", indexerFile);
    writeFileSync(indexerOut, body);
    console.log(`Wrote ${indexerOut} (${abi.length} items)`);
  }
}

emit({
  artifact: "SovereignAuctionHouse.sol/SovereignAuctionHouse.json",
  exportName: "sovereignAuctionHouseAbi",
  outFile: "sovereignAuctionHouse.ts",
  indexerFile: "SovereignAuctionHouse.ts",
});
emit({
  artifact: "SovereignAuctionHouseFactory.sol/SovereignAuctionHouseFactory.json",
  exportName: "sovereignAuctionHouseFactoryAbi",
  outFile: "sovereignAuctionHouseFactory.ts",
  indexerFile: "SovereignAuctionHouseFactory.ts",
});
emit({
  artifact: "SovereignAuctionHouseV2.sol/SovereignAuctionHouseV2.json",
  exportName: "sovereignAuctionHouseV2Abi",
  outFile: "sovereignAuctionHouseV2.ts",
  indexerFile: "SovereignAuctionHouseV2.ts",
});
emit({
  artifact: "SovereignAuctionHouseV2Factory.sol/SovereignAuctionHouseV2Factory.json",
  exportName: "sovereignAuctionHouseV2FactoryAbi",
  outFile: "sovereignAuctionHouseV2Factory.ts",
  indexerFile: "SovereignAuctionHouseV2Factory.ts",
});
