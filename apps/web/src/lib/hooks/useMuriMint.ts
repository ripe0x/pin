"use client"

import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi"
import type { Address } from "viem"
import { muriProtocolManifoldExtensionAbi } from "@pin/abi"
import { MAINNET_CHAIN_ID, MURI_MANIFOLD_EXTENSION } from "@pin/addresses"
import { FORK_CHAIN_ID } from "@/lib/wagmi"
import type { MuriInitConfig } from "@/lib/muri/build-init-config"

const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
const WRITE_CHAIN_ID = FORK_MODE ? FORK_CHAIN_ID : MAINNET_CHAIN_ID
const EXT = MURI_MANIFOLD_EXTENSION[MAINNET_CHAIN_ID]

/**
 * Mints a new MURI-native token through the Manifold extension. The token
 * lands on the artist's existing Creator Core contract (`contract`), with
 * its tokenURI routed through MURI's on-chain renderer.
 *
 * v1 mints fully off-chain: `thumbnailChunks` and `htmlTemplateChunks` are
 * empty (the config uses an off-chain thumbnail + MURI's default on-chain
 * HTML viewer). Branches on the contract standard: ERC1155 needs
 * recipients + quantities.
 */
export function useMuriMint() {
  const { address: connected } = useAccount()

  const { writeContract, data: txHash, isPending, error, reset } =
    useWriteContract()
  const {
    data: receipt,
    isLoading: isMining,
    isSuccess: receiptFetched,
  } = useWaitForTransactionReceipt({ hash: txHash })

  const isSuccess = receiptFetched && receipt?.status === "success"
  const isReverted = receiptFetched && receipt?.status === "reverted"

  function mint(args: {
    contract: Address
    isErc1155: boolean
    config: MuriInitConfig
    /** ERC1155 only: recipients + per-recipient quantities. */
    recipients?: Address[]
    quantities?: bigint[]
    /** ERC721 only: single recipient (defaults to the connected wallet). */
    recipient?: Address
  }) {
    const { contract, isErc1155, config } = args
    if (isErc1155) {
      const recipients = args.recipients ?? (connected ? [connected] : [])
      const quantities = args.quantities ?? [1n]
      writeContract({
        chainId: WRITE_CHAIN_ID,
        address: EXT,
        abi: muriProtocolManifoldExtensionAbi,
        functionName: "mintERC1155",
        args: [contract, recipients, quantities, config, [], []],
      })
    } else {
      const recipient = args.recipient ?? connected
      if (!recipient) return
      writeContract({
        chainId: WRITE_CHAIN_ID,
        address: EXT,
        abi: muriProtocolManifoldExtensionAbi,
        functionName: "mintERC721",
        args: [contract, recipient, config, [], []],
      })
    }
  }

  return {
    mint,
    txHash,
    isPending,
    isMining,
    isSuccess,
    isReverted,
    error,
    reset,
    busy: isPending || isMining,
  }
}
