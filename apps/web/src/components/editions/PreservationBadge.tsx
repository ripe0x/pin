import type {
  ArtworkPersistence,
  ArtworkPersistenceStatus,
} from "@/lib/editions-persistence"

/**
 * The honest-status badge for an edition's artwork (Phase 4). Pure display:
 * the page reads getArtworkPersistence (cached Postgres, no RPC) and passes the
 * result here. States are deliberately honest, there is no "preserved by PND"
 * because PND never holds the media.
 */

const STATUS_UI: Record<
  ArtworkPersistenceStatus,
  { label: string; dot: string; text: string; title: string } | null
> = {
  retrievable: {
    label: "Retrievable",
    dot: "bg-status-available",
    text: "text-status-available",
    title:
      "A public gateway served this artwork at the last preservation check (cached, not a live read).",
  },
  "artist-pinned": {
    label: "Artist-pinned",
    dot: "bg-status-upcoming",
    text: "text-status-upcoming",
    title:
      "The artist attested a pin of this artwork. Not yet independently verified on a public gateway.",
  },
  unretrievable: {
    label: "Not retrievable",
    dot: "bg-red-500",
    text: "text-red-500",
    title:
      "No public gateway served this artwork at the last check. The artist should re-pin it.",
  },
  unprobed: {
    label: "Not yet checked",
    dot: "bg-fg-subtle",
    text: "text-fg-subtle",
    title:
      "Content-addressed artwork that the preservation checker has not probed yet.",
  },
  external: {
    label: "Centralized link",
    dot: "bg-fg-subtle",
    text: "text-fg-subtle",
    title:
      "This artwork is a direct URL, not a content-addressed CID, so it depends on a single host staying online.",
  },
  none: null,
}

const KIND_LABEL: Record<ArtworkPersistence["kind"], string> = {
  ipfs: "IPFS",
  arweave: "Arweave",
  external: "URL",
  none: "",
}

/** Compact pill, for the edition sidebar or a gallery tile. */
export function PreservationBadge({ persistence }: { persistence: ArtworkPersistence }) {
  const ui = STATUS_UI[persistence.status]
  if (!ui) return null
  const kind = KIND_LABEL[persistence.kind]
  return (
    <span
      title={ui.title}
      className={`inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider ${ui.text}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ui.dot}`} aria-hidden="true" />
      {ui.label}
      {kind && persistence.status !== "external" ? (
        <span className="text-gray-400">· {kind}</span>
      ) : null}
    </span>
  )
}
