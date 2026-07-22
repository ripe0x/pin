/**
 * Checks every function, event, and error the web app declares in an ABI
 * against the deployed contract's actual runtime bytecode (functions,
 * events) or its compiled artifact (errors — see the note below on why
 * errors can't use the bytecode method).
 *
 * A hand-synced ABI can drift from the deployed contract: a function gets
 * removed or renamed onchain but stays in the ABI, viem happily encodes a
 * call to it, and the call reverts. In a `useReadContract` / `multicall`
 * call site that revert becomes `status !== "success"`, which most call
 * sites treat as "no data" and fall back to a default. That default can
 * read as real state — this is exactly how `maxPerAllowlisted` and
 * `allowlistMinted` (removed from HomageMinter, still in the ABI) turned a
 * reverted read into "your allowlist allocation is used up". A missing
 * error is a different failure mode: the call still reverts correctly, but
 * viem can't name the reason, so a revert reaches the UI as a bare `0x...`
 * selector instead of `RedeemLocked(opensAt)`.
 *
 * FUNCTION method: Solidity's function dispatcher compiles each selector as
 * a literal PUSH operand in the runtime bytecode, so a selector byte
 * sequence appearing anywhere in the bytecode is strong evidence the
 * function exists (dispatcher, not necessarily a data blob). A selector NOT
 * appearing anywhere is a solid negative: the function cannot be reached by
 * its own dispatcher entry. The optimizer picks the smallest PUSH that
 * fits, so a selector with leading zero bytes (e.g. 0x00844d13) compiles to
 * PUSH3 0x844d13, not PUSH4 0x00844d13 — the selector-match check strips
 * leading zero-byte pairs and checks the resulting shorter sequence too.
 * This same method is reliable for EVENT topic0 hashes: a `LOG` opcode's
 * topic is always a literal 32-byte PUSH, so it appears in full.
 *
 * One event class is exempt: an event a contract inherits from a standard
 * interface but never emits has no LOG opcode and so no topic0 in the code.
 * Those are listed in NEVER_EMITTED_EVENTS with a reason, skipped by the
 * check, and named in the output rather than dropped silently.
 *
 * ERROR method is different, deliberately NOT bytecode substring search: a
 * custom error selector is only emitted where a `revert Error(...)`
 * statement compiles, and under `via_ir` the optimizer does not reliably
 * leave it as a contiguous literal PUSH4 the way function/event selectors
 * are. Confirmed on this exact contract: `RedeemLocked(uint256)`
 * (0xf247dde6) and `PublicClosed()` (0xe23c8858) both do NOT appear as a
 * byte substring anywhere in the deployed HomageMinter bytecode, yet a live
 * `cast call` against the deployed contract reverts with exactly those
 * selectors (`redeem()` before `redeemOpensAt()`, `mint()`/`mintBatch()`
 * outside the public window) — so the bytecode-substring method gives false
 * negatives for errors and cannot gate on "absent from bytecode" the way it
 * does for functions. Error coverage is instead checked against the
 * contract's COMPILED ARTIFACT ABI (the `abi` key of a forge
 * `out/<Contract>.sol/<Contract>.json`), which lists every error the source
 * declares regardless of how the optimizer encodes the revert. This needs a
 * local `forge build` of the matching contracts checkout; it's optional — set
 * the `ARTIFACT_PATH` env vars below to enable it, otherwise the script
 * still runs the function/event bytecode checks and says plainly that error
 * coverage was skipped.
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
 *   # with error-coverage checking against a local forge build:
 *   HOMAGE_MINTER_ARTIFACT_PATH=/path/to/out/HomageMinter.sol/HomageMinter.json \
 *   HOMAGE_COLLECTION_ARTIFACT_PATH=/path/to/out/PooledSurface.sol/PooledSurface.json \
 *   HOMAGE_RENDERER_ARTIFACT_PATH=/path/to/out/HomageRendererSovereign.sol/HomageRendererSovereign.json \
 *     pnpm --filter web check:abi
 *
 * Exit code is non-zero when any declared function/event is absent from
 * bytecode, or (when an artifact path is set) when the deployed contract's
 * artifact defines an error the ABI does not declare — that inverse
 * direction is the actual drift class this was added for.
 */

import { readFileSync } from "node:fs"

import { createPublicClient, http, toFunctionSelector, toEventSelector } from "viem"

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
    artifactPath: process.env.HOMAGE_COLLECTION_ARTIFACT_PATH,
    artifactEnvVar: "HOMAGE_COLLECTION_ARTIFACT_PATH",
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
    artifactPath: process.env.HOMAGE_MINTER_ARTIFACT_PATH,
    artifactEnvVar: "HOMAGE_MINTER_ARTIFACT_PATH",
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
    artifactPath: process.env.HOMAGE_RENDERER_ARTIFACT_PATH,
    artifactEnvVar: "HOMAGE_RENDERER_ARTIFACT_PATH",
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

function eventsOf(abi) {
  return abi.filter((item) => item.type === "event")
}

function errorsOf(abi) {
  return abi.filter((item) => item.type === "error")
}

function selectorsOf(abi) {
  return functionsOf(abi).map((fn) => ({ fn, selector: toFunctionSelector(fn) }))
}

// Events an ABI declares by inheriting a standard interface but whose `emit`
// statement exists nowhere in the source. A topic0 reaches the runtime
// bytecode only where a LOG opcode compiles, so a declared-never-emitted
// event is legitimately absent from the code and is not drift. Keyed by
// event signature; each entry needs a reason.
//
// MetadataUpdate(uint256): ERC-4906 declares a single-token and a batch
// refresh event. SurfaceCore advertises 0x49064906 in supportsInterface and
// signals every refresh with the batch form (setRenderer, lockRenderer,
// notifyMetadataUpdate all emit BatchMetadataUpdate), so the single-token
// form is inherited into the compiled ABI via ISurfaceCore and never
// emitted. The ABI files are generated from the forge artifact by
// scripts/emit-surface-abi.mjs, so the entry cannot be hand-removed — the
// next regen restores it.
const NEVER_EMITTED_EVENTS = new Set(["MetadataUpdate(uint256)"])

function eventSignature(ev) {
  return `${ev.name}(${ev.inputs.map((i) => i.type).join(",")})`
}

// Event topic0 is a full 32-byte keccak of the signature, always emitted as
// a literal PUSH32 (no leading-zero-byte shrink like function selectors get,
// there is no smaller PUSH that holds 32 bytes) — the same substring method
// used for functions is reliable here too.
function topicsOf(abi) {
  return eventsOf(abi)
    .filter((ev) => !NEVER_EMITTED_EVENTS.has(eventSignature(ev)))
    .map((ev) => ({ ev, topic: toEventSelector(ev) }))
}

function skippedEventsOf(abi) {
  return eventsOf(abi).map(eventSignature).filter((sig) => NEVER_EMITTED_EVENTS.has(sig))
}

// Error selector signature string (same keccak256(sig)[0:4] formula as a
// function selector), used only to name a declared error for the artifact
// diff below — NOT checked against bytecode. See the file header for why.
function errorSignature(item) {
  const types = item.inputs.map((i) => i.type).join(",")
  return `${item.name}(${types})`
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

// ── compiled artifact (optional, for error coverage) ────────────────────

function loadArtifactAbi(path) {
  if (!path) return null
  const json = JSON.parse(readFileSync(path, "utf8"))
  if (!Array.isArray(json.abi)) throw new Error(`${path} has no top-level "abi" array`)
  return json.abi
}

// Both directions matter: an error the ABI declares that the artifact
// doesn't define is stale (should be removed); an error the artifact
// defines that the ABI doesn't declare is the actionable gap — that error's
// revert will decode as a bare selector until the ABI is synced.
function diffErrors(abiErrors, artifactErrors) {
  const abiSigs = new Set(abiErrors.map(errorSignature))
  const artifactSigs = new Set(artifactErrors.map(errorSignature))
  return {
    staleInAbi: [...abiSigs].filter((s) => !artifactSigs.has(s)).sort(),
    missingFromAbi: [...artifactSigs].filter((s) => !abiSigs.has(s)).sort(),
  }
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
  const eventFindings = []
  const skippedEvents = new Set()
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

    for (const sig of skippedEventsOf(abi)) skippedEvents.add(sig)

    const absentEvents = []
    for (const { ev, topic } of topicsOf(abi)) {
      if (!bytecodeContainsSelector(code, topic)) {
        absentEvents.push({ name: ev.name, topic, inputs: ev.inputs.map((i) => i.type).join(",") })
      }
    }
    if (absentEvents.length > 0) {
      eventFindings.push({ source, absent: absentEvents })
    }
  }

  // Error coverage: only against a compiled artifact (see file header for
  // why bytecode substring search is unreliable for error selectors), and
  // only for an ABI that declares at least one write (payable/nonpayable)
  // function. A read-only ABI subset (e.g. homageCollectionAbi's
  // ownerOf/balanceOf/tokenURI) never drives a formatWriteError-style
  // revert decode, so the full error surface of its underlying contract
  // (e.g. every ERC721/admin error PooledSurface defines) isn't a gap for
  // that ABI specifically — it's already covered wherever the write-capable
  // ABI for the same contract (pooledSurfaceAbi) is checked.
  let errorReport = null
  if (target.artifactPath) {
    const artifactAbi = loadArtifactAbi(target.artifactPath)
    const artifactErrors = errorsOf(artifactAbi)
    errorReport = target.abis
      .filter(({ abi }) => functionsOf(abi).some((fn) => fn.stateMutability === "payable" || fn.stateMutability === "nonpayable"))
      .map(({ source, abi }) => ({
        source,
        ...diffErrors(errorsOf(abi), artifactErrors),
      }))
  }

  return {
    target,
    checkedAddress,
    cloneNote,
    findings,
    eventFindings,
    skippedEvents: [...skippedEvents].sort(),
    errorReport,
  }
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
  let anyMissingErrors = false

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
      console.log("   functions: OK — every declared selector appears in the runtime bytecode.")
    } else {
      anyAbsent = true
      for (const f of r.findings) {
        console.log(`   functions ABSENT in ${f.source}:`)
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
    }

    if (r.eventFindings.length === 0) {
      console.log("   events: OK — every declared event's topic0 appears in the runtime bytecode.")
    } else {
      anyAbsent = true
      for (const f of r.eventFindings) {
        console.log(`   events ABSENT in ${f.source}:`)
        for (const a of f.absent) {
          console.log(`     - ${a.name}(${a.inputs}) topic0 ${a.topic}`)
        }
      }
    }
    if (r.skippedEvents?.length > 0) {
      console.log(
        `   events not checked (declared by a standard interface, never emitted): ${r.skippedEvents.join(", ")}`,
      )
    }

    if (r.target.artifactEnvVar && !r.target.artifactPath) {
      console.log(
        `   errors: SKIPPED — set ${r.target.artifactEnvVar} to a compiled forge artifact ` +
          `(out/<Contract>.sol/<Contract>.json) to check error coverage against it.`,
      )
    } else if (r.errorReport && r.errorReport.length === 0) {
      console.log("   errors: no write-capable ABI declared against this address — nothing to check.")
    } else if (r.errorReport) {
      for (const er of r.errorReport) {
        const clean = er.staleInAbi.length === 0 && er.missingFromAbi.length === 0
        if (clean) {
          console.log(`   errors in ${er.source}: OK — matches the compiled artifact exactly.`)
          continue
        }
        if (er.missingFromAbi.length > 0) {
          anyMissingErrors = true
          console.log(`   errors MISSING from ${er.source} (artifact defines, ABI does not declare):`)
          for (const sig of er.missingFromAbi) console.log(`     - ${sig}`)
        }
        if (er.staleInAbi.length > 0) {
          console.log(`   errors STALE in ${er.source} (ABI declares, artifact does not define):`)
          for (const sig of er.staleInAbi) console.log(`     - ${sig}`)
        }
      }
    }
    console.log("")
  }

  if (anyMissingErrors) {
    console.log(
      "FAIL: one or more compiled-artifact errors are not declared in an ABI — those reverts will decode " +
        "as a bare selector instead of a named reason. See above.",
    )
    process.exitCode = 1
  }
  if (anyAbsent) {
    console.log("FAIL: one or more declared functions/events are absent from deployed bytecode. See above.")
    process.exitCode = 1
  } else if (!anyMissingErrors) {
    console.log(
      "PASS: every checked ABI's declared functions/events resolve to a selector in bytecode, " +
        "and every artifact-checked contract's errors are fully declared.",
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
