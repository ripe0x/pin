"use client"

import type { Address } from "viem"
import { useIsRecordOwner } from "./useIsRecordOwner"
import { RecordSuccessorSection } from "./RecordSuccessorSection"
import { SuccessorEditPanel } from "./SuccessorEditPanel"

export function RecordSuccessorEditable({
  artist,
  successorChain,
}: {
  artist: Address
  successorChain: string[]
}) {
  const isOwner = useIsRecordOwner(artist)
  const hasSuccessor = successorChain.length > 1
  return (
    <div className="space-y-4">
      <RecordSuccessorSection
        artist={artist}
        successorChain={successorChain}
      />
      {isOwner && <SuccessorEditPanel alreadyDeclared={hasSuccessor} />}
    </div>
  )
}
