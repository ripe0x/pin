import { Suspense } from "react"
import { HomeSquare } from "@/components/home/HomeSquare"
import { AmbientCounters } from "@/components/home/AmbientCounters"

export default function HomePage() {
  return (
    <div className="mx-auto max-w-[2000px] px-6 py-8 space-y-12">
      {/* The page itself is the square. Hero, work, and artists share a
          single grid composition so the establishing shot and the first
          row of work read in one eye-line. */}
      <Suspense fallback={null}>
        <HomeSquare />
      </Suspense>

      {/* Ambient counters — small one-line sentence above the global
          footer (which is mounted in the root layout). */}
      <Suspense fallback={null}>
        <AmbientCounters />
      </Suspense>
    </div>
  )
}
