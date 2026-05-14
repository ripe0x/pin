/**
 * Extract a short human-readable error message from a wagmi/viem
 * error chain. Shared across the record write components so each one
 * doesn't import the others just to grab this helper.
 */
export function extractShortError(err: unknown): string {
  if (!(err instanceof Error)) return "Transaction failed."
  const m = (err as { shortMessage?: string }).shortMessage
  return m ?? err.message.split("\n")[0]
}
