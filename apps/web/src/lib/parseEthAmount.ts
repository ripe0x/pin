/**
 * Locale-tolerant ETH-amount parser.
 *
 * Returns wei or a structured rejection reason — never throws. The web app's
 * currency inputs all funnel through this so a single rule set governs what
 * the user can type, what the contract receives, and what error the UI shows.
 *
 * Rules:
 *
 *   - Whitespace, including NBSP ( ) and thin space ( ), is stripped.
 *     Copy-paste from formatted text is the common source of these.
 *
 *   - Both "." and "," are accepted as the decimal separator. When the input
 *     contains both, the LAST one wins (so "1,000.50" parses as 1000.50 and
 *     "1.000,50" also parses as 1000.50). The other character is treated as
 *     a thousands separator and must appear in valid 3-digit groupings.
 *
 *   - When only one separator type appears, a SINGLE occurrence is treated
 *     as the decimal separator. Multiple occurrences are REJECTED as ambiguous
 *     ("1,000" — does the user mean 1 ETH or 1000 ETH?), forcing the user
 *     to disambiguate. We'd rather make a German bidder retype "1.000.000"
 *     than silently parse it as 1 ETH.
 *
 *   - Scientific notation, signs, and any non-digit character outside of "."
 *     and "," are rejected.
 *
 *   - More than 18 fractional digits is rejected. viem's parseEther silently
 *     rounds; we reject so the user sees what they're submitting.
 */

import { parseEther } from "viem"

export type ParseEthAmountResult =
  | { ok: true; wei: bigint; canonical: string }
  | { ok: false; reason: string }

const NON_PRINTING_WHITESPACE = /[\s    ]+/g

export function parseEthAmount(raw: string): ParseEthAmountResult {
  const stripped = raw.replace(NON_PRINTING_WHITESPACE, "")
  if (stripped === "") return { ok: false, reason: "Enter an amount" }

  if (/[+-]/.test(stripped)) {
    return { ok: false, reason: "Negative or signed amounts aren't supported" }
  }
  // Detect scientific notation only when the rest of the input is otherwise
  // numeric — "0.5 ETH" (which becomes "0.5ETH" after whitespace strip) has
  // an `E` but it's a unit suffix, not an exponent. Better message for that
  // case is the generic digits-only error below.
  if (/^[\d.,eE]+$/.test(stripped) && /[eE]/.test(stripped)) {
    return { ok: false, reason: "Scientific notation isn't supported" }
  }
  if (!/^[\d.,]+$/.test(stripped)) {
    return { ok: false, reason: "Use digits and a single decimal point" }
  }

  const dots = countOccurrences(stripped, ".")
  const commas = countOccurrences(stripped, ",")

  let canonical: string
  if (dots > 0 && commas > 0) {
    // Mixed: the rightmost separator is the decimal, the other is thousands.
    const lastDot = stripped.lastIndexOf(".")
    const lastComma = stripped.lastIndexOf(",")
    const decimalIsDot = lastDot > lastComma
    const decimalChar = decimalIsDot ? "." : ","
    const thousandsChar = decimalIsDot ? "," : "."
    const decimalIdx = decimalIsDot ? lastDot : lastComma

    // Only one decimal allowed.
    const decimalCount = decimalIsDot ? dots : commas
    if (decimalCount !== 1) {
      return { ok: false, reason: "Only one decimal point allowed" }
    }

    const intPart = stripped.slice(0, decimalIdx)
    const fracPart = stripped.slice(decimalIdx + 1)
    const intDigits = stripWithGroupingCheck(intPart, thousandsChar)
    if (intDigits === null) {
      return { ok: false, reason: "Thousands separators must group every 3 digits" }
    }
    if (/[.,]/.test(fracPart)) {
      return { ok: false, reason: "Decimal portion can't contain separators" }
    }
    canonical = `${intDigits || "0"}.${fracPart}`
  } else if (dots + commas === 0) {
    // No separator — pure integer.
    canonical = stripped
  } else if (dots + commas === 1) {
    // Single separator anywhere — that's the decimal point.
    const sep = dots === 1 ? "." : ","
    const idx = stripped.indexOf(sep)
    const intPart = stripped.slice(0, idx)
    const fracPart = stripped.slice(idx + 1)
    canonical = `${intPart || "0"}.${fracPart}`
  } else {
    // Multiple of the same separator with no other separator type.
    // Don't try to guess thousands — the user could have meant either
    // "1,000,000" (1 million) or a typo. Make them disambiguate.
    return {
      ok: false,
      reason: "Only one decimal point allowed — remove extra separators",
    }
  }

  // At this point canonical is "INT.FRAC", "INT.", or "INT".
  // Normalize trailing/leading edge cases.
  if (canonical.endsWith(".")) canonical = canonical.slice(0, -1)
  if (canonical === "") return { ok: false, reason: "Enter an amount" }

  const [intStr, fracStr = ""] = canonical.split(".")

  // Reject leading-only zeros like "00.5" — but allow plain "0", "0.5".
  if (intStr.length > 1 && intStr.startsWith("0")) {
    return { ok: false, reason: "Remove leading zeros" }
  }

  if (fracStr.length > 18) {
    return {
      ok: false,
      reason: "ETH supports at most 18 decimal places",
    }
  }

  // Build the canonical form viem expects: trim trailing fractional zeros
  // is optional but produces a cleaner echo back to the user.
  const cleanFrac = fracStr.replace(/0+$/, "")
  const display = cleanFrac ? `${intStr}.${cleanFrac}` : intStr

  let wei: bigint
  try {
    wei = parseEther(display as `${number}`)
  } catch {
    // Should be unreachable given the validation above, but stay safe.
    return { ok: false, reason: "Couldn't parse amount" }
  }

  return { ok: true, wei, canonical: display }
}

/**
 * Clean a user-typed string for display in a currency input. Two jobs:
 *
 *   1. Strip every character that isn't a digit, "." or ",". Letters,
 *      symbols, and pasted unit suffixes ("0.5 ETH" → "0.5") disappear.
 *      Spaces are also stripped — the parser would tolerate them but the
 *      input field looks cleaner without.
 *
 *   2. When the cleaned string has exactly one comma and no period, swap
 *      the comma for a period. This canonicalises a German user's "0,5"
 *      to "0.5" so the input matches the helper text below it. We only
 *      swap when the swap is unambiguous: a string with both separators
 *      (US thousands "1,000.50" or EU thousands "1.000,50") is left alone
 *      and disambiguated by parseEthAmount at submit time.
 *
 * Use this in the input's onChange. The pure parser (parseEthAmount) is
 * still the source of truth for whether the value is valid; this helper
 * just shapes what the user can put in the field in the first place.
 */
export function cleanEthAmountInput(value: string): string {
  let cleaned = value.replace(/[^\d.,]/g, "")
  const dots = countOccurrences(cleaned, ".")
  const commas = countOccurrences(cleaned, ",")
  if (commas === 1 && dots === 0) {
    cleaned = cleaned.replace(",", ".")
  }
  return cleaned
}

function countOccurrences(s: string, ch: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++
  return n
}

/**
 * Validate that `s` (a string of digits and `sep` chars) groups its digits
 * in 3s separated by `sep`. Returns the digits-only string on success, or
 * null if the grouping is invalid. Empty input returns "".
 *
 *   "1,000"     → "1000"
 *   "1,000,000" → "1000000"
 *   "1,00"      → null  (invalid grouping)
 *   "1000"      → "1000" (no separators, accepted)
 */
function stripWithGroupingCheck(s: string, sep: string): string | null {
  if (s === "") return ""
  if (!s.includes(sep)) {
    if (/^\d+$/.test(s)) return s
    return null
  }
  const parts = s.split(sep)
  if (parts.length < 2) return null
  // First group: 1–3 digits, others: exactly 3 digits.
  if (!/^\d{1,3}$/.test(parts[0])) return null
  for (let i = 1; i < parts.length; i++) {
    if (!/^\d{3}$/.test(parts[i])) return null
  }
  return parts.join("")
}
