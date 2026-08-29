export default function ProfileLoading() {
  return (
    <div className="mx-auto max-w-[2000px] space-y-8 px-6 py-12">
      <div className="flex items-center gap-5">
        <div className="h-20 w-20 rounded-full skeleton" />
        <div className="space-y-3">
          <div className="h-5 w-48 rounded skeleton" />
          <div className="h-3 w-32 rounded skeleton" />
        </div>
      </div>
      <div className="h-16 rounded skeleton" />
      <p className="text-sm text-gray-500">Loading indexed profile evidence…</p>
    </div>
  )
}
