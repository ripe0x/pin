import type { Address, Hex } from "viem"
import { ReleaseSpecValidationError, normalizeJsonValue } from "./json.ts"
import type { JsonValue } from "./types.ts"

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH32 = /^0x[0-9a-fA-F]{64}$/
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/
const CAPABILITY = /^[a-z0-9.-]+@[1-9][0-9]*$/
const CHAIN_REFERENCE = /^[1-9][0-9]*$/

export function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ReleaseSpecValidationError("expected object", path)
  }
  return value as Record<string, unknown>
}

export function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new ReleaseSpecValidationError(`unknown key ${JSON.stringify(key)}`, path)
  }
  for (const key of required) {
    if (!(key in value)) throw new ReleaseSpecValidationError(`missing required key ${JSON.stringify(key)}`, path)
  }
}

export function stringAt(
  value: unknown,
  path: string,
  options: { min?: number; max?: number; pattern?: RegExp } = {},
): string {
  if (typeof value !== "string") throw new ReleaseSpecValidationError("expected string", path)
  if (options.min !== undefined && value.length < options.min) {
    throw new ReleaseSpecValidationError(`must contain at least ${options.min} characters`, path)
  }
  if (options.max !== undefined && value.length > options.max) {
    throw new ReleaseSpecValidationError(`must contain at most ${options.max} characters`, path)
  }
  if (options.pattern && !options.pattern.test(value)) {
    throw new ReleaseSpecValidationError("has an invalid format", path)
  }
  return value
}

export function optionalString(
  object: Record<string, unknown>,
  key: string,
  path: string,
  options: { min?: number; max?: number; pattern?: RegExp } = {},
): string | undefined {
  return object[key] === undefined ? undefined : stringAt(object[key], `${path}.${key}`, options)
}

export function literalAt<T extends string | number>(value: unknown, literal: T, path: string): T {
  if (value !== literal) throw new ReleaseSpecValidationError(`expected ${JSON.stringify(literal)}`, path)
  return literal
}

export function addressAt(value: unknown, path: string): Address {
  const address = stringAt(value, path, { pattern: ADDRESS }).toLowerCase()
  return address as Address
}

export function hash32At(value: unknown, path: string): Hex {
  return stringAt(value, path, { pattern: HASH32 }).toLowerCase() as Hex
}

export function signatureAt(value: unknown, path: string): Hex {
  return stringAt(value, path, { pattern: SIGNATURE }).toLowerCase() as Hex
}

export function capabilityAt(value: unknown, path: string): string {
  return stringAt(value, path, { pattern: CAPABILITY })
}

export function chainReferenceAt(value: unknown, path: string): string {
  return stringAt(value, path, { pattern: CHAIN_REFERENCE })
}

export function dateTimeAt(value: unknown, path: string): string {
  const raw = stringAt(value, path)
  const epoch = Date.parse(raw)
  if (!Number.isFinite(epoch) || !/(?:Z|[+-]\d\d:\d\d)$/.test(raw)) {
    throw new ReleaseSpecValidationError("expected an RFC 3339 timestamp with timezone", path)
  }
  return new Date(epoch).toISOString()
}

export function positiveIntegerAt(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ReleaseSpecValidationError("expected a positive safe integer", path)
  }
  return value as number
}

export function httpsUrlAt(value: unknown, path: string): string {
  const raw = stringAt(value, path, { min: 1, max: 4096 })
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ReleaseSpecValidationError("expected an absolute URL", path)
  }
  if (url.protocol !== "https:") throw new ReleaseSpecValidationError("expected an https URL", path)
  if (url.username || url.password) throw new ReleaseSpecValidationError("URL credentials are not allowed", path)
  return raw
}

export function absoluteUrlAt(value: unknown, path: string): string {
  const raw = stringAt(value, path, { min: 1, max: 4096 })
  try {
    const url = new URL(raw)
    if (url.protocol === "javascript:" || url.protocol === "data:") throw new Error("unsafe")
  } catch {
    throw new ReleaseSpecValidationError("expected a safe absolute URL", path)
  }
  return raw
}

export function jsonRecordAt(value: unknown, path: string): Record<string, JsonValue> {
  const object = objectAt(value, path)
  return normalizeJsonValue(object, path) as Record<string, JsonValue>
}
