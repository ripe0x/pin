import Image from "next/image"
import Link from "next/link"
import { ConnectButton } from "./ConnectButton"
import { getConfig } from "@/lib/config"
import { getArtistDisplayName } from "@/lib/artist"

export async function ArtistHeader() {
  const cfg = getConfig()
  const displayName = await getArtistDisplayName()
  return (
    <header className="border-b border-[hsl(var(--border))]">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-3">
          {cfg.artistAvatarUrl ? (
            <Image
              src={cfg.artistAvatarUrl}
              alt={displayName}
              width={36}
              height={36}
              unoptimized
            />
          ) : (
            <div
              aria-hidden
              className="flex h-9 w-9 items-center justify-center bg-[hsl(var(--muted))] text-sm font-semibold"
            >
              {displayName.charAt(0).toUpperCase()}
            </div>
          )}
          <span className="text-base font-semibold tracking-tight">
            {displayName}
          </span>
        </Link>
        <ConnectButton />
      </div>
    </header>
  )
}
