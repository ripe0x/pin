"use client"

import { RainbowKitProvider, lightTheme, darkTheme } from "@rainbow-me/rainbowkit"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { WagmiProvider } from "wagmi"
import { useEffect, useState, type ReactNode } from "react"
import { ThemeProvider, useTheme } from "next-themes"
import { config } from "@/lib/wagmi"
import { DevImpersonate } from "@/components/DevImpersonate"

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
  // Defaults tuned for chain-data reads via wagmi. Out of the box
  // react-query treats every query as immediately stale, so each
  // useReadContract remount or tab-focus event refires its underlying
  // eth_call — meaningful RPC volume on auction pages where 4–5 hooks
  // re-evaluate per route hop. A 30s staleTime + no window-focus
  // refetch covers casual tab toggling without delaying genuinely new
  // state (post-bid revalidation paths use queryClient.invalidateQueries
  // or pass query: { staleTime: 0 } at the call site).
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  )

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
          <RainbowKitWithTheme>
            <DevImpersonate />
            {children}
          </RainbowKitWithTheme>
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  )
}
