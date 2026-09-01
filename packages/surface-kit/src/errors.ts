const PROTOCOL_ERROR_COPY: Record<string, string> = {
  WrongPayment: "The price changed since the page loaded. The quote has been refreshed, try again.",
  Underpayment: "The price changed since the page loaded. The quote has been refreshed, try again.",
  ExceedsCap: "Sold out during your transaction. Gas is consumed on failed transactions.",
  MintNotStarted: "The mint window is not open.",
  MintEnded: "The mint window is not open.",
  HookRejected: "This mint has additional onchain conditions that were not met.",
  NotAllowlisted: "This wallet is not on the allowlist for this mint.",
  WalletCapExceeded: "This wallet has reached its per-wallet mint limit.",
}

export function formatWriteError(err: unknown, action: string): string {
  if (!err || typeof err !== "object") return `${action} failed`
  const error = err as { message?: string; shortMessage?: string; cause?: unknown; metaMessages?: string[] }
  if (error.message?.includes("User rejected")) return "Transaction rejected"
  if (error.message?.includes("insufficient funds")) return "Insufficient ETH balance"

  const seen: string[] = []
  let node: unknown = err
  for (let i = 0; i < 8 && node && typeof node === "object"; i++) {
    const current = node as {
      data?: { errorName?: string }
      reason?: string
      shortMessage?: string
      message?: string
      metaMessages?: string[]
      cause?: unknown
    }
    if (current.data?.errorName) seen.push(current.data.errorName)
    if (current.reason) seen.push(current.reason)
    if (current.shortMessage) seen.push(current.shortMessage)
    if (current.message) seen.push(current.message)
    if (Array.isArray(current.metaMessages)) seen.push(...current.metaMessages)
    node = current.cause
  }
  for (const [name, copy] of Object.entries(PROTOCOL_ERROR_COPY)) {
    const boundary = new RegExp(`\\b${name}\\b`)
    if (seen.some((message) => message === name || boundary.test(message))) return copy
  }

  let deepest = error.shortMessage
  let current = error.cause
  for (let i = 0; i < 6 && current && typeof current === "object"; i++) {
    const cause = current as { shortMessage?: string; reason?: string; cause?: unknown }
    if (cause.shortMessage) deepest = cause.shortMessage
    if (cause.reason) deepest = cause.reason
    current = cause.cause
  }
  if (!deepest && Array.isArray(error.metaMessages)) {
    deepest = error.metaMessages.find((message) => /::|reverted|require/i.test(message))?.trim()
  }
  if (!deepest) deepest = error.message?.split("\n")[0]
  return `${action} failed: ${deepest ?? "unknown error"}`
}
