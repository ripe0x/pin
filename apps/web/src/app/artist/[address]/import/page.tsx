import { redirect } from "next/navigation"

/**
 * The catalog import planner moved into the studio. This route
 * survives only as a redirect (preserving ?source=) because the old
 * URL is shared in chats and bookmarks. The raw param passes through
 * untouched — the studio layout handles ENS resolution and
 * canonicalization.
 */

type Params = Promise<{ address: string }>
type SearchParams = Promise<{ source?: string }>

export default async function ImportRedirect({
  params,
  searchParams,
}: {
  params: Params
  searchParams: SearchParams
}) {
  const { address: raw } = await params
  const { source } = await searchParams
  const suffix = source ? `?source=${encodeURIComponent(source)}` : ""
  redirect(`/studio/${raw}/catalog/import${suffix}`)
}
