import { redirect } from "next/navigation"

/**
 * The migrate flow moved into the studio. This route survives only as
 * a redirect because the old URL is in guides, chats, and bookmarks.
 * The raw param passes through untouched — the studio layout handles
 * ENS resolution and canonicalization.
 */

type Params = Promise<{ address: string }>

export default async function MigrateRedirect({
  params,
}: {
  params: Params
}) {
  const { address: raw } = await params
  redirect(`/studio/${raw}/migrate`)
}
