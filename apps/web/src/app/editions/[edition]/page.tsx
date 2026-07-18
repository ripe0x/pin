import { redirect } from "next/navigation"

type Params = Promise<{ edition: string }>

// Editions is retired in favor of Collections; the address param carries
// straight over since both are keyed by contract address.
export default async function EditionRedirect({ params }: { params: Params }) {
  const { edition } = await params
  redirect(`/collections/${edition}`)
}
