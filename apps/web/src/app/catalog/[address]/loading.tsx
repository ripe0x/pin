export default function Loading() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12 space-y-10">
      <div className="flex items-center gap-6">
        <div className="h-20 w-20 shrink-0 rounded-full skeleton" />
        <div className="space-y-2">
          <div className="h-4 w-40 rounded skeleton" />
          <div className="h-3 w-24 rounded skeleton" />
        </div>
      </div>
      <p className="text-sm text-gray-500">Loading catalog…</p>
    </div>
  )
}
