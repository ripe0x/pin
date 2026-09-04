export type MintPhase = {
  key: string
  label: string
  window: { startFn: string; endFn?: string }
  mintFn: string
  eligibility?: string
  argsBuilder?: string
  priceQuote?: string
  selector?: string
  noun?: string
}

export type PhaseWindow = { key: string; label: string; start: string; end: string }

export type PhaseState = {
  activeIndex: number
  activeKey: string | null
  nextIndex: number
  nextKey: string | null
  nextStart: bigint
  anyScheduled: boolean
  allEnded: boolean
}

export function resolvePhaseState(windows: PhaseWindow[], nowSec: number): PhaseState {
  const now = BigInt(Math.max(0, nowSec))
  let activeIndex = -1
  let anyScheduled = false
  for (let i = 0; i < windows.length; i++) {
    const start = BigInt(windows[i]!.start)
    if (start === 0n) continue
    anyScheduled = true
    const end = BigInt(windows[i]!.end)
    if (now >= start && (end === 0n || now < end)) activeIndex = i
  }

  let nextIndex = -1
  let nextStart = 0n
  for (let i = 0; i < windows.length; i++) {
    const start = BigInt(windows[i]!.start)
    if (start === 0n || start <= now) continue
    if (nextStart === 0n || start < nextStart) {
      nextStart = start
      nextIndex = i
    }
  }

  return {
    activeIndex,
    activeKey: activeIndex >= 0 ? windows[activeIndex]!.key : null,
    nextIndex,
    nextKey: nextIndex >= 0 ? windows[nextIndex]!.key : null,
    nextStart,
    anyScheduled,
    allEnded: anyScheduled && activeIndex === -1 && nextIndex === -1,
  }
}
