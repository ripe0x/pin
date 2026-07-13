"use client"

/**
 * The GENERATIVE preset's preview step: renders the artist's script against
 * 4 synthetic test seeds, byte-identical to what the onchain
 * GenerativeRenderer will produce (docs/injection-convention.md parity
 * rule). The artist's script hasn't been uploaded yet, so it's resolved
 * from an in-memory Map (bytesResolver) while dependencies resolve from
 * chain via layeredResolver — this is the exact reason layeredResolver
 * exists (local bytes win, everything else falls through to chain).
 */

import { useMemo } from "react"
import { usePublicClient, useChainId } from "wagmi"
import {
  TokenPreview,
  makeTestTokenData,
  layeredResolver,
  defaultGunzip,
  fileKey,
  CODE_KIND,
  type CodeRefLike,
} from "@/lib/collection-render"
import { KNOWN_DEPENDENCIES, dependencyCodeRef } from "@/lib/create-collection"
import { CaptureCover } from "./CaptureCover"
import type { WizardState } from "./types"
import { BTN, BTN_SECONDARY } from "./wizard-ui"

const LOCAL_SCRIPT_KEY = "studio-preview:artist-script"
const PREVIEW_SEED_COUNT = 4

export function PreviewStep({
  state,
  set,
  onBack,
  onNext,
}: {
  state: WizardState
  set: <K extends keyof WizardState>(key: K, value: WizardState[K]) => void
  onBack: () => void
  onNext: () => void
}) {
  const publicClient = usePublicClient()
  const chainId = useChainId()

  const localScriptRef: CodeRefLike = useMemo(
    () => ({
      store: "0x0000000000000000000000000000000000000000",
      name: LOCAL_SCRIPT_KEY,
      kind: CODE_KIND.Script,
    }),
    [],
  )

  const depRefs = useMemo<CodeRefLike[]>(
    () =>
      state.selectedDeps
        .map((id) => KNOWN_DEPENDENCIES.find((d) => d.id === id))
        .filter((d): d is (typeof KNOWN_DEPENDENCIES)[number] => !!d)
        .map((d) => dependencyCodeRef(d.file, chainId))
        .filter((ref): ref is NonNullable<typeof ref> => ref !== null)
        .map((ref) => ({ ...ref, kind: ref.kind as CodeRefLike["kind"] })),
    [state.selectedDeps, chainId],
  )

  const files = useMemo(() => {
    const map = new Map<string, string | Uint8Array>()
    map.set(fileKey(localScriptRef), state.script)
    return map
  }, [localScriptRef, state.script])

  const resolver = useMemo(
    () => (publicClient ? layeredResolver(files, publicClient) : null),
    [files, publicClient],
  )

  const gunzip = useMemo(() => defaultGunzip(chainId), [chainId])

  const work = useMemo(
    () => ({
      code: [localScriptRef],
      deps: depRefs,
      injectionVersion: 1,
    }),
    [localScriptRef, depRefs],
  )

  const seeds = useMemo(
    () =>
      Array.from({ length: PREVIEW_SEED_COUNT }, (_, i) =>
        makeTestTokenData({ index: i, chainId }),
      ),
    [chainId],
  )

  if (!resolver) {
    return (
      <div className="space-y-4">
        <p className="text-xs text-gray-500">Connect a wallet to load a preview client.</p>
        <button onClick={onBack} className={BTN_SECONDARY}>
          Back
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <header className="space-y-1.5">
        <h3 className="text-sm font-medium">Preview</h3>
        <p className="text-xs text-gray-500 leading-relaxed">
          Four synthetic seeds, rendered exactly as the onchain renderer will render
          real mints. If a dependency shows unresolved content, verify it against the
          fork before uploading.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3">
        {seeds.map((seed) => (
          <TokenPreview
            key={seed.tokenId}
            work={work}
            tokenData={seed}
            resolver={resolver}
            gunzip={gunzip}
            className="aspect-square w-full overflow-hidden rounded border border-gray-200 bg-surface-muted"
            title={`Test seed ${seed.tokenId}`}
          />
        ))}
      </div>

      <CaptureCover
        work={work}
        tokenData={seeds[0]}
        resolver={resolver}
        gunzip={gunzip}
        value={state.artworkURI}
        onCaptured={(uri) => set("artworkURI", uri)}
      />

      <div className="flex gap-3">
        <button onClick={onBack} className={BTN_SECONDARY}>
          Back
        </button>
        <button onClick={onNext} className={BTN}>
          Looks right, continue
        </button>
      </div>
    </div>
  )
}
