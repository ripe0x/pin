"use client"

import { ConnectButton as RKConnectButton } from "@rainbow-me/rainbowkit"

/**
 * Custom-rendered Connect button so the chrome matches the bid button:
 * square corners, `bg-fg text-bg`, hover opacity. RainbowKit's default
 * is pill-shaped which clashes with the rest of the site.
 */
export function ConnectButton() {
  return (
    <RKConnectButton.Custom>
      {({ account, chain, openAccountModal, openConnectModal, mounted }) => {
        const ready = mounted
        const connected = ready && account && chain
        const baseClass =
          "text-sm font-medium px-4 py-2 bg-fg text-bg hover:opacity-80 transition-opacity"
        if (!ready) {
          return (
            <span
              aria-hidden
              className={baseClass}
              style={{ opacity: 0, pointerEvents: "none", userSelect: "none" }}
            >
              Connect Wallet
            </span>
          )
        }
        if (!connected) {
          return (
            <button type="button" onClick={openConnectModal} className={baseClass}>
              Connect Wallet
            </button>
          )
        }
        return (
          <button
            type="button"
            onClick={openAccountModal}
            className={baseClass}
          >
            {account.displayName}
          </button>
        )
      }}
    </RKConnectButton.Custom>
  )
}
