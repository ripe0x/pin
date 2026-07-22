/**
 * Checks every function the web app declares in an ABI against the
 * deployed contract's actual runtime bytecode.
 *
 * A hand-synced ABI can drift from the deployed contract: a function gets
 * removed or renamed onchain but stays in the ABI, viem happily encodes a
 * call to it, and the call reverts. In a `useReadContract` / `multicall`
 * call site that revert becomes `status !== "success"`, which most call
 * sites treat as "no data" and fall back to a default. That default can
 * read as real state — this is exactly how `maxPerAllowlisted` and
 * `allowlistMinted` (removed from HomageMinter, still in the ABI) turned a
 * reverted read into "your allowlist allocation is used up".
 *
 * Method: Solidity's function dispatcher compiles each selector as a literal
 * PUSH operand in the runtime bytecode, so a selector byte sequence
 * appearing anywhere in the bytecode is strong evidence the function exists
 * (dispatcher, not necessarily a data blob). A selector NOT appearing
 * anywhere is a solid negative: the function cannot be reached by its own
 * dispatcher entry. The optimizer picks the smallest PUSH that fits, so a
 * selector with leading zero bytes (e.g. 0x00844d13) compiles to PUSH3
 * 0x844d13, not PUSH4 0x00844d13 — the selector-match check strips leading
 * zero-byte pairs and checks the resulting shorter sequence too.
 *
 * EIP-1167 minimal-proxy clones (e.g. the Homage collection) forward every
 * call to a fixed implementation address baked into ~45 bytes of stub
 * bytecode. The stub does not contain function selectors, so this script
 * detects the clone shape, extracts the implementation address, and checks
 * selectors against the implementation's code instead.
 *
 * Run:
 *   node --experimental-strip-types apps/web/scripts/check-abi-vs-bytecode.mjs
 *   pnpm --filter web check:abi
 *
 * Exit code is non-zero when any declared function is absent from bytecode,
 * so this can gate a deploy.
 */

import { createPublicClient, http, toFunctionSelector } from "viem"

import {
  surfaceFactoryAbi,
  catalogAbi,
  surfaceAbi,
  pooledSurfaceAbi,
  fixedPriceMinterAbi,
  homageMinterAbi as pkgHomageMinterAbi,
  homageCollectionAbi as pkgHomageCollectionAbi,
  homageRendererAbi as pkgHomageRendererAbi,
} from "@pin/abi"
import { ARTIST_RECORD_REGISTRY, SURFACE_FACTORY, MAINNET_CHAIN_ID } from "@pin/addresses"

import {
  homageMinterAbi as webHomageMinterAbi,
  homageCollectionAbi as webHomageCollectionAbi,
  homageRendererViewAbi as webHomageRendererViewAbi,
  punksMarketAbi as webPunksMarketAbi,
  wrappedPunksAbi as webWrappedPunksAbi,
  delegateRegistryAbi as webDelegateRegistryAbi,
  stateViewAbi as webStateViewAbi,
  v4QuoterAbi as webV4QuoterAbi,
} from "../src/lib/homage/contracts.ts"

const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com"
const MAINNET_RPC = "https://ethereum-rpc.publicnode.com"
const SEPOLIA_CHAIN_ID = 11155111

const sepoliaClient = createPublicClient({ transport: http(SEPOLIA_RPC) })
const mainnetClient = createPublicClient({ transport: http(MAINNET_RPC) })

// ── source files to grep for call sites, relative to apps/web/scripts/ ─────
const GREP_ROOTS = ["../src"]

// ── target list ──────────────────────────────────────────────────────────
// Each target: one contract address, the chain it lives on, and every ABI
// the web app declares and actually reads against it. Map narrowly — an
// ABI is only checked against the addresses it is used for, not every
// address in the list.

const sepoliaTargets = [
  {
    label: "SurfaceFactory (sepolia)",
    chainId: SEPOLIA_CHAIN_ID,
    client: sepoliaClient,
    address: "0x0CEF49b9852546Ace7F4DbF22032b4e76A3908d2",
    abis: [{ source: "@pin/abi surfaceFactoryAbi", abi: surfaceFactoryAbi }],
  },
  {
    label: "Catalog (sepolia)",
    chainId: SEPOLIA_CHAIN_ID,
    client: sepoliaClient,
    address: "0x77E0B8d90b48b0976F7f6f0AFaEd0dc4b4c38130",
    abis: [{ source: "@pin/abi catalogAbi", abi: catalogAbi }],
  },
  {
    label: "Surface (sequential) implementation (sepolia)",
    chainId: SEPOLIA_CHAIN_ID,
    client: sepoliaClient,
    address: "0x912Ea34E54Ae65ca46D1bACfF294A104Eea78475",
    abis: [{ source: "@pin/abi surfaceAbi", abi: surfaceAbi }],
  },
  {
    label: "PooledSurface implementation (sepolia)",
    chainId: SEPOLIA_CHAIN_ID,
    client: sepoliaClient,
    address: "0x45306a18f0eAC100107c428A4Da87EcACabE5D0D",
    abis: [{ source: "@pin/abi pooledSurfaceAbi", abi: pooledSurfaceAbi }],
  },
  {
    label: "FixedPriceMinter implementation (sepolia)",
    chainId: SEPOLIA_CHAIN_ID,
    client: sepoliaClient,
    address: "0xa49E9e0B806519E65d0BC7A52C5DbC7f2f458763",
    abis: [{ source: "@pin/abi fixedPriceMinterAbi", abi: fixedPriceMinterAbi }],
  },
  {
    label: "Homage collection (sepolia, EIP-1167 clone of PooledSurface)",
    chainId: SEPOLIA_CHAIN_ID,
    client: sepoliaClient,
    address: "0x2A7D93ed950D3F2381E167926463C6A341939e82",
    resolveClone: true,
    abis: [
      { source: "@pin/abi pooledSurfaceAbi", abi: pooledSurfaceAbi },
      { source: "@pin/abi homageCollectionAbi", abi: pkgHomageCollectionAbi },
      { source: "apps/web/src/lib/homage/contracts.ts homageCollectionAbi", abi: webHomageCollectionAbi },
    ],
  },
  {
    label: "HomageMinter (sepolia)",
    chainId: SEPOLIA_CHAIN_ID,
    client: sepoliaClient,
    address: "0xc9f3c81556fcb4cf70a37d1a7248d6ec68256b7c",
    abis: [
      { source: "@pin/abi homageMinterAbi", abi: pkgHomageMinterAbi },
      { source: "apps/web/src/lib/homage/contracts.ts homageMinterAbi", abi: webHomageMinterAbi },
    ],
  },
  {
    label: "HomageRendererSovereign (sepolia)",
    chainId: SEPOLIA_CHAIN_ID,
    client: sepoliaClient,
    address: "0xb842131d085bcf6caa1d51157897030fc92a04b1",
    abis: [
      { source: "@pin/abi homageRendererAbi", abi: pkgHomageRendererAbi },
      { source: "apps/web/src/lib/homage/contracts.ts homageRendererViewAbi", abi: webHomageRendererViewAbi },
    ],
  },
  {
    label: "HomageFeeSplitter (sepolia)",
    chainId: SEPOLIA_CHAIN_ID,
    client: sepoliaClient,
    address: "0xc737453ac09c8c9812ecce1595afd2884992072e",
    abis: [],
    note: "No ABI declared against this address anywhere in apps/web/src — nothing to check.",
  },
]

const mainnetTargets = [
  {
    label: "Catalog (mainnet)",
    chainId: MAINNET_CHAIN_ID,
    client: mainnetClient,
    address: ARTIST_RECORD_REGISTRY[MAINNET_CHAIN_ID],
    abis: [{ source: "@pin/abi catalogAbi", abi: catalogAbi }],
  },
  {
    label: "CryptoPunksMarket (mainnet)",
    chainId: MAINNET_CHAIN_ID,
    client: mainnetClient,
    address: "0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB",
    abis: [{ source: "apps/web/src/lib/homage/contracts.ts punksMarketAbi", abi: webPunksMarketAbi }],
  },
  {
    label: "WrappedPunks (mainnet)",
    chainId: MAINNET_CHAIN_ID,
    client: mainnetClient,
    address: "0xb7F7F6C52F2e2fdb1963Eab30438024864c313F6",
    abis: [{ source: "apps/web/src/lib/homage/contracts.ts wrappedPunksAbi", abi: webWrappedPunksAbi }],
  },
  {
    label: "delegate.xyz v2 (mainnet)",
    chainId: MAINNET_CHAIN_ID,
    client: mainnetClient,
    address: "0x00000000000000447e69651d841bD8D104Bed493",
    abis: [{ source: "apps/web/src/lib/homage/contracts.ts delegateRegistryAbi", abi: webDelegateRegistryAbi }],
  },
  {
    label: "Uniswap v4 StateView (mainnet)",
    chainId: MAINNET_CHAIN_ID,
    client: mainnetClient,
    address: "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227",
    abis: [{ source: "apps/web/src/lib/homage/contracts.ts stateViewAbi", abi: webStateViewAbi }],
  },
  {
    label: "Uniswap v4 Quoter (mainnet)",
    chainId: MAINNET_CHAIN_ID,
    client: mainnetClient,
    address: "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203",
    abis: [{ source: "apps/web/src/lib/homage/contracts.ts v4QuoterAbi", abi: webV4QuoterAbi }],
  },
]

// $111 token and Surface system contracts are skipped on mainnet: $111 is
// checked only via a plain ERC-20 `parseAbi` ad hoc in a couple of call
// sites (no drift risk worth automating here), and the Surface system is
// NOT deployed to mainnet yet (SURFACE_FACTORY is still the zero address).
const surfaceFactoryMainnet = SURFACE_FACTORY[MAINNET_CHAIN_ID]
const surfaceSystemSkippedOnMainnet =
  !surfaceFactoryMainnet || surfaceFactoryMainnet === "0x0000000000000000000000000000000000000000"

// ── EIP-1167 minimal-proxy detection ────────────────────────────────────

const CLONE_RE = /^0x363d3d373d3d3d363d73([0-9a-fA-F]{40})5af43d82803e903d91602b57fd5bf3$/

function resolveCloneImplementation(code) {
  const m = CLONE_RE.exec(code)
  return m ? `0x${m[1]}` : null
}

// ── selectors ────────────────────────────────────────────────────────────

function functionsOf(abi) {
  return abi.filter((item) => item.type === "function")
}

function selectorsOf(abi) {
  return functionsOf(abi).map((fn) => ({ fn, selector: toFunctionSelector(fn) }))
}

function bytecodeContainsSelector(codeHex, selector) {
  // codeHex and selector are both 0x-prefixed lowercase hex. The dispatcher
  // pushes the selector as the smallest PUSH that fits (PUSH1..PUSH4): a
  // selector with N leading zero bytes compiles to PUSH(4-N) of the
  // remaining bytes, not a literal 4-byte PUSH4. A selector like
  // 0x00844d13 (contractURI(address)) shows up in bytecode as PUSH3
  // 0x844d13, not PUSH4 0x00844d13 — check the full selector first, then
  // progressively shorter suffixes with the leading zero bytes stripped.
  let hex = selector.slice(2)
  while (hex.length >= 2) {
    if (codeHex.includes(hex)) return true
    if (hex.slice(0, 2) !== "00") return false
    hex = hex.slice(2)
  }
  return false
}

// ── call-site grep ──────────────────────────────────────────────────────

async function grepCallSites(functionName) {
  const { execSync } = await import("node:child_process")
  const here = new URL(".", import.meta.url).pathname
  const results = []
  for (const root of GREP_ROOTS) {
    const dir = new URL(root, `file://${here}`).pathname
    try {
      const out = execSync(
        `grep -rn --include='*.ts' --include='*.tsx' -F '"${functionName}"' ${JSON.stringify(dir)}`,
        { encoding: "utf8" },
      )
      for (const line of out.trim().split("\n")) {
        if (line) results.push(line.replace(dir, "apps/web/src/"))
      }
    } catch {
      // grep exits 1 on no matches; that's a valid "no call sites" result.
    }
  }
  return results
}

// ── main ─────────────────────────────────────────────────────────────────

async function checkTarget(target) {
  const findings = []
  const codeRaw = await target.client.getCode({ address: target.address })
  if (!codeRaw || codeRaw === "0x") {
    return { target, error: "no code at this address (not deployed on this RPC/chain)" }
  }

  let code = codeRaw.toLowerCase()
  let checkedAddress = target.address
  let cloneNote = null

  if (target.resolveClone) {
    const impl = resolveCloneImplementation(codeRaw)
    if (impl) {
      cloneNote = `EIP-1167 clone; implementation resolved to ${impl}`
      const implCode = await target.client.getCode({ address: impl })
      if (!implCode || implCode === "0x") {
        return { target, error: `resolved clone implementation ${impl} has no code` }
      }
      code = implCode.toLowerCase()
      checkedAddress = impl
    } else {
      cloneNote = "expected an EIP-1167 clone but the bytecode did not match the minimal-proxy shape; checking as-is"
    }
  }

  for (const { source, abi } of target.abis) {
    const absent = []
    for (const { fn, selector } of selectorsOf(abi)) {
      if (!bytecodeContainsSelector(code, selector)) {
        absent.push({ name: fn.name, selector, inputs: fn.inputs.map((i) => i.type).join(",") })
      }
    }
    if (absent.length > 0) {
      for (const a of absent) {
        a.callSites = await grepCallSites(a.name)
      }
      findings.push({ source, absent })
    }
  }

  return { target, checkedAddress, cloneNote, findings }
}

async function main() {
  const allTargets = [...sepoliaTargets, ...mainnetTargets]
  const results = []
  for (const target of allTargets) {
    if (target.abis.length === 0) {
      results.push({ target, findings: [], note: target.note })
      continue
    }
    try {
      results.push(await checkTarget(target))
    } catch (e) {
      results.push({ target, error: e instanceof Error ? e.message : String(e) })
    }
  }

  console.log("ABI vs onchain bytecode check")
  console.log(`sepolia RPC: ${SEPOLIA_RPC}`)
  console.log(`mainnet RPC: ${MAINNET_RPC}`)
  console.log(
    `Surface system on mainnet: ${
      surfaceSystemSkippedOnMainnet ? "not deployed (SURFACE_FACTORY is zero) — skipped" : "deployed, checked"
    }`,
  )
  console.log("")

  let anyAbsent = false

  for (const r of results) {
    console.log(`## ${r.target.label}`)
    console.log(`   chain ${r.target.chainId}  address ${r.target.address}`)
    if (r.note) {
      console.log(`   ${r.note}`)
      console.log("")
      continue
    }
    if (r.error) {
      console.log(`   ERROR: ${r.error}`)
      console.log("")
      continue
    }
    if (r.cloneNote) console.log(`   ${r.cloneNote}`)
    if (r.findings.length === 0) {
      console.log("   OK — every declared function's selector appears in the runtime bytecode.")
      console.log("")
      continue
    }
    anyAbsent = true
    for (const f of r.findings) {
      console.log(`   ABSENT in ${f.source}:`)
      for (const a of f.absent) {
        console.log(`     - ${a.name}(${a.inputs}) selector ${a.selector}`)
        if (a.callSites.length === 0) {
          console.log("       call sites: none found")
        } else {
          console.log("       call sites:")
          for (const cs of a.callSites) console.log(`         ${cs}`)
        }
      }
    }
    console.log("")
  }

  if (anyAbsent) {
    console.log("FAIL: one or more declared functions are absent from deployed bytecode. See above.")
    process.exitCode = 1
  } else {
    console.log("PASS: every checked ABI's declared functions resolve to a selector in bytecode.")
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
