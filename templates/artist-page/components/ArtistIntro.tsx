import Image from "next/image"
import { getConfig } from "@/lib/config"
import { getArtistDisplayName } from "@/lib/artist"

export async function ArtistIntro() {
  const cfg = getConfig()
  const displayName = await getArtistDisplayName()
  return (
    <section className="mx-auto max-w-5xl px-6 pt-12 pb-8">
      <div className="flex flex-col items-start gap-6 sm:flex-row sm:items-center">
        {cfg.artistAvatarUrl ? (
          <Image
            src={cfg.artistAvatarUrl}
            alt={displayName}
            width={96}
            height={96}
            unoptimized
          />
        ) : (
          <div
            aria-hidden
            className="flex h-24 w-24 items-center justify-center bg-[hsl(var(--muted))] text-4xl font-semibold"
          >
            {displayName.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="flex-1">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            {displayName}
          </h1>
          {cfg.artistBio ? (
            <p className="mt-2 max-w-2xl text-[hsl(var(--muted-foreground))]">
              {cfg.artistBio}
            </p>
          ) : null}
          {cfg.artistLinks.length > 0 ? (
            <ul className="mt-3 flex flex-wrap gap-3 text-sm">
              {cfg.artistLinks.map((url) => (
                <li key={url}>
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[hsl(var(--muted-foreground))] underline-offset-4 hover:text-[hsl(var(--foreground))] hover:underline"
                  >
                    {prettyHostname(url)}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function prettyHostname(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}
