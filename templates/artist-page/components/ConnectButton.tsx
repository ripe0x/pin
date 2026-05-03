"use client"

import { ConnectButton as RKConnectButton } from "@rainbow-me/rainbowkit"

export function ConnectButton() {
  return <RKConnectButton showBalance={false} chainStatus="none" />
}
