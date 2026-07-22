// Presentation for the mint schedule: the card, its rows, and the state dot. Shared by
// the pre-deploy landing (static windows) and the live collection page (windows read
// from the minter), so the two never drift apart. No chain reads here, which keeps the
// pre-deploy landing's bundle free of wagmi.

import {type ReactNode} from "react"

const META = "text-[10px] font-mono uppercase tracking-wider text-gray-400"

export type WindowState = "upcoming" | "live" | "ended"

export type ScheduleRow = {
  name: string
  /** Formatted opening time. A node so callers can swap server and client renders. */
  time: ReactNode
  detail: string
  state: WindowState
}

function dotClass(state: WindowState): string {
  if (state === "live") return "bg-status-available animate-pulse"
  if (state === "ended") return "bg-gray-300 dark:bg-gray-700"
  return "bg-status-upcoming"
}

export function HomageScheduleCard({rows, empty}: {rows: ScheduleRow[]; empty?: ReactNode}) {
  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-surface p-5">
      <h3 className={META}>Mint schedule</h3>
      {rows.length === 0 ? (
        <p className="text-[11px] font-mono text-gray-500">{empty ?? "Not yet scheduled."}</p>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((r) => (
            <li key={r.name} className="space-y-0.5">
              <div className="flex items-center gap-2 text-[11px] font-mono">
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass(r.state)}`} />
                <span className={r.state === "ended" ? "text-gray-400 line-through" : "text-fg"}>
                  {r.name}
                </span>
              </div>
              <p className="pl-3.5 text-[11px] font-mono tabular-nums text-fg-muted">{r.time}</p>
              <p className="pl-3.5 text-[10px] font-mono text-gray-500">{r.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
