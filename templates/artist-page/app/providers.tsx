"use client"

import { useState, type ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { WagmiProvider } from "wagmi"
import { RainbowKitProvider, lightTheme, darkTheme } from "@rainbow-me/rainbowkit"
import { getWagmiConfig } from "@/lib/wagmi-config"

export function Providers({ children }: { children: ReactNode }) {
  // useState ensures one instance per browser session, so HMR / route changes
  // don't blow away in-flight queries.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false },
        },
      }),
  )
  const [wagmiConfig] = useState(() => getWagmiConfig())

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={{
            lightMode: lightTheme(),
            darkMode: darkTheme(),
          }}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
