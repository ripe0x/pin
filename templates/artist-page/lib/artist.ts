/**
 * Server-side helpers for the artist's identity. Each piece resolves through
 * a small fallback chain so the deploy form can stay minimal — only the
 * wallet address is required, and we fill in the rest from ENS.
 *
 *   Display name:  NEXT_PUBLIC_ARTIST_NAME env  →  ENS reverse  →  truncated addr
 *   Avatar:        NEXT_PUBLIC_ARTIST_AVATAR_URL  →  ENS `avatar` text record  →  null (caller draws gradient)
 *   Bio:           NEXT_PUBLIC_ARTIST_BIO  →  ENS `description` text record  →  null
 *   Links:         NEXT_PUBLIC_ARTIST_LINKS  →  ENS `url`/`com.twitter`/etc text records  →  []
 *
 * All ENS lookups are cached 6 hours per (name, key) pair via `lib/ens.ts`,
 * so calling these per render is cheap.
 */
import "server-only"
import { getConfig } from "./config"
import { getEnsName, getEnsText } from "./ens"
import { formatAddress } from "./format"

const IPFS_GATEWAY = "https://nftstorage.link/ipfs/"

export async function getArtistDisplayName(): Promise<string> {
  const cfg = getConfig()
  if (cfg.artistName) return cfg.artistName
  const ens = await getEnsName(cfg.artistAddress)
  if (ens) return ens
  return formatAddress(cfg.artistAddress)
}

/**
 * Resolved avatar URL or null. Falls back to ENS `avatar` text record when
 * the env var isn't set. ENS avatar values can take several forms; we
 * handle plain HTTP(S), IPFS, and bail on more exotic cases like NFT-as-avatar
 * (`eip155:1/erc721:...`) which require a separate token-image lookup. The
 * gradient fallback in the UI covers anything that returns null here.
 */
export async function getArtistAvatarUrl(): Promise<string | null> {
  const cfg = getConfig()
  if (cfg.artistAvatarUrl) return cfg.artistAvatarUrl
  const ens = await getEnsName(cfg.artistAddress)
  if (!ens) return null
  const raw = await getEnsText(ens, "avatar")
  if (!raw) return null
  return resolveAvatarUri(raw)
}

/**
 * Resolved bio. Falls back to the ENS `description` text record.
 */
export async function getArtistBio(): Promise<string | null> {
  const cfg = getConfig()
  if (cfg.artistBio) return cfg.artistBio
  const ens = await getEnsName(cfg.artistAddress)
  if (!ens) return null
  return getEnsText(ens, "description")
}

/**
 * Resolved social/personal links. Falls back to a small set of common ENS
 * text records (`url`, `com.twitter`, `org.farcaster`, etc.) — each present
 * value becomes a link.
 */
const SOCIAL_TEXT_KEYS: Array<{ key: string; format: (v: string) => string | null }> = [
  { key: "url", format: (v) => (v.startsWith("http") ? v : `https://${v}`) },
  {
    key: "com.twitter",
    format: (v) => `https://x.com/${v.replace(/^@/, "")}`,
  },
  {
    key: "org.farcaster",
    format: (v) => `https://farcaster.xyz/${v.replace(/^@/, "")}`,
  },
  {
    key: "com.github",
    format: (v) => `https://github.com/${v}`,
  },
]

export async function getArtistLinks(): Promise<string[]> {
  const cfg = getConfig()
  if (cfg.artistLinks.length > 0) return cfg.artistLinks
  const ens = await getEnsName(cfg.artistAddress)
  if (!ens) return []
  const results = await Promise.all(
    SOCIAL_TEXT_KEYS.map(async ({ key, format }) => {
      const v = await getEnsText(ens, key)
      return v ? format(v) : null
    }),
  )
  return results.filter((v): v is string => !!v)
}

/**
 * Normalize an ENS avatar value into something a `<img>` tag can render.
 * Bails (returns null) on `eip155:` NFT-as-avatar references — those need
 * a token-image lookup we don't currently do.
 */
function resolveAvatarUri(raw: string): string | null {
  if (raw.startsWith("ipfs://")) {
    return IPFS_GATEWAY + raw.slice("ipfs://".length).replace(/^ipfs\//, "")
  }
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return raw
  }
  if (raw.startsWith("data:")) {
    return raw
  }
  // eip155:1/erc721:... or other exotic forms — skip for now.
  return null
}
