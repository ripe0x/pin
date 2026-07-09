import { redirect } from "next/navigation"

// Editions is retired in favor of Collections (same underlying protocol,
// carried forward as Collection). Redirect rather than 404 so any
// bookmarked or externally linked /editions URL still lands somewhere live.
export default function EditionsRedirect() {
  redirect("/collections")
}
