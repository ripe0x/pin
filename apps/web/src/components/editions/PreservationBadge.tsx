import type {
  ArtworkDurability,
  ArtworkPersistence,
  ArtworkPersistenceStatus,
} from "@/lib/editions-persistence"
import { durabilityLabel } from "@/lib/editions-durability"

/**
 * The honest-status badge for an edition's artwork. Pure display: the page reads
 * getArtworkPersistence (cached Postgres, no RPC) and passes the result here.
 * States are deliberately honest, there is no "preserved by PND" because PND
 * never holds the media.
 *
 * Two orthogonal dimensions (Phase 3): the RETRIEVABILITY pill (did a gateway
 * serve it) and the DURABILITY pill (permanent floor vs rented hot pin vs
 * lapsed). Only a resolved Arweave floor ever reads as "permanent".
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

// Durability pill styling. "none" renders nothing. Only permanent-floor uses the
// "available" (green) treatment; hot-funded is neutral (rented, not permanent),
// hot-lapsed is the red failure state.
const DURABILITY_UI: Record<
  ArtworkDurability,
  { dot: string; text: string; title: string } | null
> = {
  "permanent-floor": {
    dot: "bg-status-available",
    text: "text-status-available",
    title:
      "A pay-once Arweave copy resolved at the last check — a permanent floor that does not need renewal.",
  },
  "hot-funded": {
    dot: "bg-status-upcoming",
    text: "text-status-upcoming",
    title:
      "A renewable pin is funded through this date. This is rented availability, not permanence — it lapses without renewal.",
  },
  "hot-lapsed": {
    dot: "bg-red-500",
    text: "text-red-500",
    title:
      "A previously-funded pin has lapsed and there is no permanent floor. The artist should fund the work's permanence.",
  },
  none: null,
}

/** Compact pill(s), for the edition sidebar or a gallery tile. */
export function PreservationBadge({ persistence }: { persistence: ArtworkPersistence }) {
  const ui = STATUS_UI[persistence.status]
  if (!ui) return null
  const kind = KIND_LABEL[persistence.kind]
  const dur = DURABILITY_UI[persistence.durability]
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
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
      {dur ? (
        <span
          title={dur.title}
          className={`inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider ${dur.text}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${dur.dot}`} aria-hidden="true" />
          {durabilityLabel(persistence.durability, persistence.fundedThrough)}
        </span>
      ) : null}
    </span>
  )
}
