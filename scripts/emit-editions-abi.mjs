#!/usr/bin/env node
/**
 * Extract PND Editions ABIs from forge build artifacts and write them as
 * TypeScript modules under packages/abi/src.
 *
 * Run after any change to the editions Solidity contracts:
 *   cd contracts && forge build
 *   node scripts/emit-editions-abi.mjs
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
  const body = `// Auto-extracted from contracts/out/${artifact}.\n// Re-run: node scripts/emit-editions-abi.mjs\nexport const ${exportName} = ${JSON.stringify(abi, null, 2)} as const;\n`;
  writeFileSync(out, body);
  console.log(`Wrote ${out} (${abi.length} items)`);
}

emit({
  artifact: "PNDEditions.sol/PNDEditions.json",
  exportName: "pndEditionsAbi",
  outFile: "pndEditions.ts",
});
emit({
  artifact: "PNDEditionsFactory.sol/PNDEditionsFactory.json",
  exportName: "pndEditionsFactoryAbi",
  outFile: "pndEditionsFactory.ts",
});

// Reference mint-hook library (public goods, one shared instance per hook).
emit({
  artifact: "PNDPerWalletCapHook.sol/PNDPerWalletCapHook.json",
  exportName: "pndPerWalletCapHookAbi",
  outFile: "pndPerWalletCapHook.ts",
});
emit({
  artifact: "PNDAllowlistHook.sol/PNDAllowlistHook.json",
  exportName: "pndAllowlistHookAbi",
  outFile: "pndAllowlistHook.ts",
});
emit({
  artifact: "PNDHoldsEditionHook.sol/PNDHoldsEditionHook.json",
  exportName: "pndHoldsEditionHookAbi",
  outFile: "pndHoldsEditionHook.ts",
});

// PND Editions MURI bridge operator.
emit({
  artifact: "PNDEditionsMuriOperator.sol/PNDEditionsMuriOperator.json",
  exportName: "pndEditionsMuriOperatorAbi",
  outFile: "pndEditionsMuriOperator.ts",
});
