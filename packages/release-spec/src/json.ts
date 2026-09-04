import type { JsonValue } from "./types.ts"

export class ReleaseSpecValidationError extends Error {
  readonly path: string

  constructor(message: string, path = "$") {
    super(`${path}: ${message}`)
    this.name = "ReleaseSpecValidationError"
    this.path = path
  }
}

/** Parse JSON without silently accepting duplicate object keys. */
export function parseStrictJson(text: string): JsonValue {
  let index = 0

  const fail = (message: string): never => {
    throw new ReleaseSpecValidationError(`${message} at byte ${index}`)
  }

  const whitespace = () => {
    while (/\s/.test(text[index] ?? "")) index += 1
  }

  const stringValue = (): string => {
    if (text[index] !== '"') fail("expected string")
    const start = index
    index += 1
    while (index < text.length) {
      const char = text[index]
      if (char === '"') {
        index += 1
        try {
          return JSON.parse(text.slice(start, index)) as string
        } catch {
          fail("invalid string")
        }
      }
      if (char === "\\") {
        index += 2
        continue
      }
      if ((char?.charCodeAt(0) ?? 0) < 0x20) fail("unescaped control character")
      index += 1
    }
    return fail("unterminated string")
  }

  const value = (): JsonValue => {
    whitespace()
    const char = text[index]
    if (char === '"') return stringValue()
    if (char === "{") return objectValue()
    if (char === "[") return arrayValue()
    if (text.startsWith("true", index)) {
      index += 4
      return true
    }
    if (text.startsWith("false", index)) {
      index += 5
      return false
    }
    if (text.startsWith("null", index)) {
      index += 4
      return null
    }
    const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (!match) return fail("expected JSON value")
    index += match[0].length
    const parsed = Number(match[0])
    if (!Number.isFinite(parsed)) return fail("number is not finite")
    return parsed
  }

  const arrayValue = (): JsonValue[] => {
    index += 1
    whitespace()
    const result: JsonValue[] = []
    if (text[index] === "]") {
      index += 1
      return result
    }
    while (true) {
      result.push(value())
      whitespace()
      if (text[index] === "]") {
        index += 1
        return result
      }
      if (text[index] !== ",") return fail("expected ',' or ']'")
      index += 1
    }
  }

  const objectValue = (): Record<string, JsonValue> => {
    index += 1
    whitespace()
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
    const keys = new Set<string>()
    if (text[index] === "}") {
      index += 1
      return result
    }
    while (true) {
      whitespace()
      const key = stringValue()
      if (keys.has(key)) return fail(`duplicate object key ${JSON.stringify(key)}`)
      keys.add(key)
      whitespace()
      if (text[index] !== ":") return fail("expected ':'")
      index += 1
      result[key] = value()
      whitespace()
      if (text[index] === "}") {
        index += 1
        return result
      }
      if (text[index] !== ",") return fail("expected ',' or '}'")
      index += 1
    }
  }

  const parsed = value()
  whitespace()
  if (index !== text.length) fail("unexpected trailing content")
  return parsed
}

export function canonicalizeJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ReleaseSpecValidationError("number is not finite")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key]!)}`).join(",")}}`
}

export function normalizeJsonValue(value: unknown, path = "$", seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ReleaseSpecValidationError("number is not finite", path)
    return value
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new ReleaseSpecValidationError("cyclic value", path)
    seen.add(value)
    const normalized = value.map((item, i) => normalizeJsonValue(item, `${path}[${i}]`, seen))
    seen.delete(value)
    return normalized
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new ReleaseSpecValidationError("cyclic value", path)
    seen.add(value)
    const normalized: Record<string, JsonValue> = {}
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeJsonValue((value as Record<string, unknown>)[key], `${path}.${key}`, seen)
    }
    seen.delete(value)
    return normalized
  }
  throw new ReleaseSpecValidationError("value is not valid JSON", path)
}
