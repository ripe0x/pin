import Link from "next/link"

/**
 * Public entry points keep the front door useful even when the activity index
 * is temporarily unavailable. They also make collector discovery as visible as
 * artist tooling without turning the home page into a marketplace grid.
 */
export function HomeEntryPoints() {
  const linkClass =
    "text-xs font-mono text-gray-500 hover:text-fg transition-colors underline underline-offset-4"

  return (
    <nav aria-label="Start here" className="flex flex-wrap gap-x-5 gap-y-2">
      <Link href="/collections" className={linkClass}>Browse collections</Link>
      <Link href="/auctions" className={linkClass}>Browse auctions</Link>
      <Link href="/catalog" className={linkClass}>Explore the Catalog</Link>
      <Link href="/studio" className={linkClass}>Open your studio</Link>
    </nav>
  )
}
