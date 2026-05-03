import Link from "next/link"
import { ArtistHeader } from "@/components/ArtistHeader"

export default function NotFound() {
  return (
    <div className="min-h-screen">
      <ArtistHeader />
      <main className="mx-auto max-w-3xl px-6 py-20 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Not found</h1>
        <p className="mt-3 text-[hsl(var(--muted-foreground))]">
          That auction doesn&apos;t exist on this house.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-md bg-[hsl(var(--accent))] px-4 py-2 text-sm font-medium text-[hsl(var(--accent-foreground))]"
        >
          Back to all auctions
        </Link>
      </main>
    </div>
  )
}
