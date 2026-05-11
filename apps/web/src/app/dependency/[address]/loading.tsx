export default function Loading() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10 space-y-8">
      <header className="space-y-1">
        <div className="text-xs uppercase tracking-wide text-gray-500">
          Artist dependency scan
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Artist dependency check
        </h1>
      </header>
      <p className="text-sm text-gray-500">Loading scan...</p>
    </div>
  )
}
