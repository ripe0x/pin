export default function ArtistLoading() {
  return (
    <div className="mx-auto max-w-[2000px] px-6 py-12">
      {/* Header skeleton */}
      <div className="flex items-center gap-6">
        <div className="h-20 w-20 rounded-full skeleton" />
        <div className="space-y-3">
          <div className="h-7 w-48 rounded skeleton" />
          <div className="h-4 w-32 rounded skeleton" />
        </div>
      </div>

      {/* Intentionally no status message here. This file is the route-level
          loading fallback that flashes briefly during navigation BEFORE the
          page component runs. The cache-aware "Indexing…" / "Loading artist."
          copy lives in the inner Suspense fallback inside page.tsx, where we
          have access to the address + can distinguish cold vs. warm cache. */}

      {/* Grid skeleton */}
      <div className="mt-8 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="space-y-3">
            <div className="aspect-[4/5] rounded-lg skeleton" />
            <div className="h-4 w-3/4 rounded skeleton" />
            <div className="h-3 w-1/2 rounded skeleton" />
          </div>
        ))}
      </div>
    </div>
  )
}
