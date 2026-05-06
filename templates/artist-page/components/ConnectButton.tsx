"use client"

import { ConnectButton as RKConnectButton } from "@rainbow-me/rainbowkit"

/**
 * Custom-rendered Connect button so the chrome matches the bid button:
 * square corners, monospace uppercase, `bg-fg text-bg`, hover opacity.
 */
export function ConnectButton() {
  return (
    <RKConnectButton.Custom>
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

        const baseBtn =
          "inline-flex items-center gap-2 text-[11px] font-mono font-medium uppercase tracking-wider px-3 py-2 bg-fg text-bg hover:opacity-80 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg"

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
    </RKConnectButton.Custom>
  )
}
