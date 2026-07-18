import { redirect } from "next/navigation"

type Params = Promise<{ edition: string; tokenId: string }>

// Editions is retired in favor of Collections; address + tokenId carry
// straight over.
export default async function EditionTokenRedirect({ params }: { params: Params }) {
  const { edition, tokenId } = await params
  redirect(`/collections/${edition}/${tokenId}`)
}
