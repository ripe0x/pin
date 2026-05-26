export default function Loading() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12 space-y-10">
      {/* Identity row */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
        <div className="h-20 w-20 shrink-0 rounded-full skeleton" />
        <div className="space-y-2">
          <div className="h-4 w-40 rounded skeleton" />
          <div className="h-3 w-24 rounded skeleton" />
          <div className="h-3 w-32 rounded skeleton" />
        </div>
      </div>

      {/* One section skeleton — section header + a couple of rows */}
      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <div className="h-4 w-24 rounded skeleton" />
          <div className="h-3 w-16 rounded skeleton" />
        </div>
        {Array.from({ length: 2 }).map((_, i) => (
          <div
            key={i}
            className="border border-gray-200 rounded-md px-3 py-2.5 flex items-center gap-3"
          >
            <div className="h-10 w-10 shrink-0 rounded-md skeleton" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="h-3 w-32 rounded skeleton" />
              <div className="h-3 w-56 rounded skeleton" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
