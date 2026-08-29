import { permanentRedirect } from "next/navigation"

type Params = Promise<{ address: string }>

/** Preserve old artist links while profiles become the canonical identity route. */
export default async function ArtistCompatibilityPage({
  params,
}: {
  params: Params
}) {
  const { address } = await params
  permanentRedirect(`/profile/${encodeURIComponent(decodeURIComponent(address))}`)
}
