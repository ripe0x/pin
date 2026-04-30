"use client"

import { RainbowKitProvider, lightTheme, darkTheme } from "@rainbow-me/rainbowkit"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { WagmiProvider } from "wagmi"
import { useEffect, useState, type ReactNode } from "react"
import { ThemeProvider, useTheme } from "next-themes"
import { config } from "@/lib/wagmi"

import "@rainbow-me/rainbowkit/styles.css"

const rkLight = lightTheme({
  accentColor: "#000000",
  accentColorForeground: "#FFFFFF",
  borderRadius: "medium",
  fontStack: "system",
})

const rkDark = darkTheme({
  accentColor: "#F5F5F5",
  accentColorForeground: "#0A0A0A",
  borderRadius: "medium",
  fontStack: "system",
})

function RainbowKitWithTheme({ children }: { children: ReactNode }) {
  const { resolvedTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const theme = mounted && resolvedTheme === "dark" ? rkDark : rkLight

  return <RainbowKitProvider theme={theme}>{children}</RainbowKitProvider>
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      storageKey="foundation-theme"
      disableTransitionOnChange
    >
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <RainbowKitWithTheme>{children}</RainbowKitWithTheme>
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  )
}
