"use client"

import { useAccount, useChainId, useSwitchChain } from "wagmi"
import { mainnet } from "wagmi/chains"
import { forkChain, FORK_CHAIN_NAME } from "@/lib/wagmi"

const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
const PREFERRED_CHAIN = FORK_MODE ? forkChain : mainnet
const PREFERRED_CHAIN_LABEL = FORK_MODE ? FORK_CHAIN_NAME : "Ethereum"

/**
 * Wallet-chain status indicator above the Add form. Renders nothing when
 * disconnected or when the wallet is already on the preferred chain;
 * shows an amber banner with a switch button on a chain mismatch.
 */
export function ChainSwitcher() {
  const { isConnected } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending } = useSwitchChain()

  if (!isConnected) return null
  if (chainId === PREFERRED_CHAIN.id) return null

  return (
    <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 flex items-center justify-between gap-3">
      <p className="text-xs text-amber-900 leading-relaxed">
        Your wallet is on chain id <code>{chainId}</code>. Switch to{" "}
        <span className="font-medium">{PREFERRED_CHAIN_LABEL}</span> (chain id{" "}
        <code>{PREFERRED_CHAIN.id}</code>) to sign catalog transactions.
        {FORK_MODE && (
          <>
            {" "}If your wallet doesn't have this network yet, accept the prompt
            to add it (RPC <code>http://localhost:8546</code>).
          </>
        )}
      </p>
      <button
        onClick={() => switchChain({ chainId: PREFERRED_CHAIN.id })}
        disabled={isPending}
        className="text-[11px] font-mono font-medium uppercase tracking-wider px-3 py-1.5 bg-fg text-bg hover:opacity-80 transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isPending ? "Switching…" : `Switch to ${PREFERRED_CHAIN_LABEL}`}
      </button>
    </div>
  )
}
