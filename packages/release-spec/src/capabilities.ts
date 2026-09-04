import type { CapabilityState, ReleaseManifestV1 } from "./types.ts"

export const CORE_CAPABILITIES = [
  "surface.state@1",
  "surface.quote@1",
  "surface.mint@1",
  "surface.render.token@1",
  "surface.render.preview@1",
  "surface.reveal@1",
  "surface.referral@1",
  "history.mints@1",
  "history.sales@1",
  "history.bids@1",
  "history.ownership@1",
  "identity.ens@1",
  "media.prepared@1",
  "editorial.pnd@1",
] as const

export type CoreCapability = (typeof CORE_CAPABILITIES)[number]

export type CapabilitySupport = {
  intrinsic?: readonly string[]
  adapters?: readonly string[]
}

export function negotiateCapabilities(
  manifest: ReleaseManifestV1,
  support: CapabilitySupport,
): { compatible: boolean; states: Record<string, CapabilityState> } {
  const intrinsic = new Set(support.intrinsic ?? [])
  const adapters = new Set(support.adapters ?? [])
  const bindings = new Map(manifest.capabilities.adapters.map((binding) => [binding.capability, binding]))
  const required = new Set(manifest.capabilities.required)
  const requested = [...required, ...(manifest.capabilities.optional ?? [])]
  const states: Record<string, CapabilityState> = {}

  for (const capability of requested) {
    if (intrinsic.has(capability)) {
      states[capability] = { status: "supported", adapter: "intrinsic" }
      continue
    }
    const binding = bindings.get(capability)
    if (binding && adapters.has(binding.adapter)) {
      states[capability] = { status: "supported", adapter: binding.adapter }
      continue
    }
    const reason = binding
      ? `Adapter ${binding.adapter} is not available`
      : `No adapter is declared for ${capability}`
    states[capability] = required.has(capability)
      ? { status: "incompatible", reason }
      : { status: "unsupported", reason }
  }

  return {
    compatible: Object.values(states).every((state) => state.status !== "incompatible"),
    states,
  }
}
