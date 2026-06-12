"use client"

import Link from "next/link"
import { useAccount } from "wagmi"
import { useConnectModal } from "@rainbow-me/rainbowkit"
import { useRouter } from "next/navigation"

/**
 * Three plain-text entry points for the home hero. Two of them
 * (deploy / sell) require a connected wallet — they open the connect
 * modal when disconnected, otherwise route to the artist's studio
 * auctions tab, where deploying and listing both live.
 */
export function HomeEntryPoints() {
  const { address } = useAccount()
  const { openConnectModal } = useConnectModal()
  const router = useRouter()

  function handleConnectGated(e: React.MouseEvent) {
    e.preventDefault()
    if (address) {
      router.push(`/studio/${address.toLowerCase()}/auctions`)
    } else {
      openConnectModal?.()
    }
  }

  const linkClass =
    "text-sm text-gray-500 hover:text-fg transition-colors underline-offset-4"

  return (
    <p className="text-sm text-gray-500">
      <Link href="/preserve" className={linkClass}>
        preserve your work
      </Link>
      <span className="mx-2 text-gray-300">·</span>
      <a href="#" onClick={handleConnectGated} className={linkClass}>
        deploy a sovereign auction house
      </a>
      <span className="mx-2 text-gray-300">·</span>
      <a href="#" onClick={handleConnectGated} className={linkClass}>
        sell your work
      </a>
    </p>
  )
}
