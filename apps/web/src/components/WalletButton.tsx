"use client"

import { ConnectButton } from "@rainbow-me/rainbowkit"

/**
 * Wallet connect / account button. Extracted from the navbar so the desktop
 * actions row and the mobile hamburger panel render the exact same control
 * instead of two copies of the RainbowKit custom render.
 *
 * `fullWidth` stretches it to fill the mobile panel; desktop leaves it auto.
 */
export function WalletButton({ fullWidth = false }: { fullWidth?: boolean }) {
  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        openAccountModal,
        openChainModal,
        openConnectModal,
        authenticationStatus,
        mounted,
      }) => {
        const ready = mounted && authenticationStatus !== "loading"
        const connected =
          ready &&
          account &&
          chain &&
          (!authenticationStatus || authenticationStatus === "authenticated")

        const baseBtn = `inline-flex items-center gap-2 text-[11px] font-mono font-medium uppercase tracking-wider px-3 py-2 bg-fg text-bg hover:opacity-80 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg${
          fullWidth ? " w-full justify-center" : ""
        }`

        return (
          <div
            {...(!ready && {
              "aria-hidden": true,
              style: {
                opacity: 0,
                pointerEvents: "none",
                userSelect: "none",
              },
            })}
            className={fullWidth ? "w-full" : undefined}
          >
            {(() => {
              if (!connected) {
                return (
                  <button
                    type="button"
                    onClick={openConnectModal}
                    className={baseBtn}
                  >
                    Connect wallet
                  </button>
                )
              }
              if (chain.unsupported) {
                return (
                  <button
                    type="button"
                    onClick={openChainModal}
                    className={baseBtn}
                  >
                    Wrong network
                  </button>
                )
              }
              return (
                <button
                  type="button"
                  onClick={openAccountModal}
                  className={baseBtn}
                >
                  {process.env.NODE_ENV === "development" && chain.iconUrl && (
                    <img
                      src={chain.iconUrl}
                      alt={chain.name ?? "chain"}
                      className="h-4 w-4 rounded-full"
                    />
                  )}
                  {account.ensAvatar && (
                    <img
                      src={account.ensAvatar}
                      alt=""
                      className="h-4 w-4 rounded-full"
                    />
                  )}
                  <span>{account.displayName}</span>
                </button>
              )
            })()}
          </div>
        )
      }}
    </ConnectButton.Custom>
  )
}
