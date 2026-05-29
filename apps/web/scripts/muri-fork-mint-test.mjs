/**
 * MURI mint write-path verification against an Anvil mainnet fork.
 *
 * Exercises the full on-chain flow PND drives from /muri, using the real
 * buildInitConfig + ABIs, by impersonating a Manifold contract's admin:
 *   registerExtension -> registerContract -> mintERC721 / mintERC1155
 * then asserts MURI stored the fallback URIs and the token's metadata
 * routes through MURI's on-chain renderer. Covers both 721 and 1155.
 *
 * This is a MANUAL test (needs Anvil + network), not part of CI. The
 * encoding half is unit-tested in src/lib/muri/build-init-config.test.ts.
 *
 * Run:
 *   ~/.foundry/bin/anvil --fork-url https://ethereum-rpc.publicnode.com --silent &
 *   node --experimental-strip-types apps/web/scripts/muri-fork-mint-test.mjs
 */
import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  http,
  parseEventLogs,
  getAddress,
} from "viem"
import { mainnet } from "viem/chains"
import {
  muriProtocolManifoldExtensionAbi,
  muriProtocolAbi,
  ierc721CreatorCoreAbi,
} from "@pin/abi"
import { MURI_PROTOCOL, MURI_MANIFOLD_EXTENSION } from "@pin/addresses"
import { buildInitConfig } from "../src/lib/muri/build-init-config.ts"

const RPC = process.env.FORK_RPC ?? "http://localhost:8545"
const MURI = MURI_PROTOCOL[1]
const EXT = MURI_MANIFOLD_EXTENSION[1]

const pub = createPublicClient({ chain: mainnet, transport: http(RPC) })
const test = createTestClient({ chain: mainnet, mode: "anvil", transport: http(RPC) })

const uriFn = {
  type: "function",
  name: "uri",
  stateMutability: "view",
  inputs: [{ type: "uint256" }],
  outputs: [{ type: "string" }],
}
const tokenUriFn = { ...uriFn, name: "tokenURI" }

async function run(label, { contract, is1155 }) {
  const C = getAddress(contract)
  const owner = await pub.readContract({
    address: C,
    abi: ierc721CreatorCoreAbi,
    functionName: "owner",
  })
  await test.impersonateAccount({ address: owner })
  await test.setBalance({ address: owner, value: 10n ** 19n })
  const wallet = createWalletClient({ account: owner, chain: mainnet, transport: http(RPC) })
  const wait = (h) => pub.waitForTransactionReceipt({ hash: h })

  await wait(
    await wallet.writeContract({
      address: C,
      abi: ierc721CreatorCoreAbi,
      functionName: "registerExtension",
      args: [EXT, ""],
    }),
  )
  await wait(
    await wallet.writeContract({
      address: MURI,
      abi: muriProtocolAbi,
      functionName: "registerContract",
      args: [C, EXT],
    }),
  )

  const artworkUris = [
    "https://nftstorage.link/ipfs/bafyFORKTEST",
    "https://dweb.link/ipfs/bafyFORKTEST",
  ]
  const config = buildInitConfig({
    name: `${label} fork piece`,
    description: "minted on anvil fork",
    artworkUris,
    mimeType: "image/png",
    fileHash: "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  })

  const mintHash = is1155
    ? await wallet.writeContract({
        address: EXT,
        abi: muriProtocolManifoldExtensionAbi,
        functionName: "mintERC1155",
        args: [C, [owner], [3n], config, [], []],
      })
    : await wallet.writeContract({
        address: EXT,
        abi: muriProtocolManifoldExtensionAbi,
        functionName: "mintERC721",
        args: [C, owner, config, [], []],
      })
  const receipt = await wait(mintHash)

  const logs = parseEventLogs({
    abi: muriProtocolManifoldExtensionAbi,
    logs: receipt.logs,
    eventName: is1155 ? "TokenMintedERC1155" : "TokenMintedERC721",
  })
  const tokenId = logs[0].args.tokenId

  const storedUris = await pub.readContract({
    address: MURI,
    abi: muriProtocolAbi,
    functionName: "getArtistArtworkUris",
    args: [C, tokenId],
  })
  const metaUri = await pub.readContract({
    address: C,
    abi: ierc721CreatorCoreAbi.concat([is1155 ? uriFn : tokenUriFn]),
    functionName: is1155 ? "uri" : "tokenURI",
    args: [tokenId],
  })

  const urisMatch = JSON.stringify(storedUris) === JSON.stringify(artworkUris)
  const routesThroughMuri = metaUri.startsWith("data:application/json")
  const pass = receipt.status === "success" && urisMatch && routesThroughMuri
  console.log(
    `${label}: mint=${receipt.status} tokenId=${tokenId} urisMatch=${urisMatch} muriRouted=${routesThroughMuri} => ${pass ? "PASS" : "FAIL"}`,
  )
  return pass
}

const results = []
results.push(
  await run("ERC721", { contract: "0x26bc6f16cd0103f69ec12e4f20396ce56d71ceef", is1155: false }),
)
results.push(
  await run("ERC1155", { contract: "0xCb337152b6181683010D07e3f00e7508cd348BC7", is1155: true }),
)
console.log(results.every(Boolean) ? "\nALL PASS ✓" : "\nFAILURES ✗")
process.exit(results.every(Boolean) ? 0 : 1)
