import { redirect } from "next/navigation"

// Editions is retired in favor of Collections. There is no dedicated
// /collections/new landing yet (creation lives in the studio flow), so this
// redirects to the collections landing rather than a route that doesn't exist.
export default function EditionsNewRedirect() {
  redirect("/collections")
}
