"use client"

export type PinStats = {
  total: number
  pinned: number
  pinning: number
  failed: number
  queued: number
  /** First error message encountered — shown to help users diagnose failures. */
  lastError?: string
}

export function PinProgress({
  stats,
  isRunning,
}: {
  stats: PinStats
  isRunning: boolean
}) {
  const done = stats.pinned + stats.failed
  const progress = stats.total > 0 ? (done / stats.total) * 100 : 0

  return (
    <div className="space-y-3">
      {/* Progress bar */}
      <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
        <div
          className="h-full rounded-full bg-black transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Stats */}
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-4">
          {stats.pinned > 0 && (
            <span className="text-green-600">
              {stats.pinned} pinned
            </span>
          )}
          {(stats.pinning + stats.queued) > 0 && (
            <span className="text-yellow-600">
              {stats.pinning + stats.queued} in progress
            </span>
          )}
          {stats.failed > 0 && (
            <span className="text-red-500">
              {stats.failed} failed
            </span>
          )}
        </div>
        <span className="text-gray-400">
          {done} / {stats.total} files
        </span>
      </div>

      {/* Completion message */}
      {!isRunning && done === stats.total && stats.total > 0 && (
        <div
          className={`rounded-lg border p-4 text-sm ${
            stats.failed === 0
              ? "bg-green-50 border-green-200 text-green-800"
              : "bg-red-50 border-red-200 text-red-800"
          }`}
        >
          <p>
            {stats.failed === 0
              ? `All ${stats.pinned} files pinned successfully.`
              : `${stats.pinned} of ${stats.total} files pinned. ${stats.failed} failed — you can retry those below.`}
          </p>
          {stats.lastError && (
            <p className="mt-2 text-xs opacity-80">
              Error: {stats.lastError}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
