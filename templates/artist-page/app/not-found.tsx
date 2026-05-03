import Link from "next/link"

export default function NotFound() {
  return (
    <div className="mx-auto max-w-[2000px] px-6 py-12 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Not Found</h1>
      <p className="text-fg-muted mt-2">
        That auction doesn&apos;t exist on this house.
      </p>
      <Link
        href="/"
        className="mt-6 inline-block text-xs border border-gray-200 px-3 py-1.5 rounded-full hover:border-gray-400 transition-colors"
      >
        ← Back to all auctions
      </Link>
    </div>
  )
}
