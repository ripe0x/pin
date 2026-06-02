/**
 * Renders an edition's outgoing Edition Graph edges. Reads from onchain data
 * (passed in), so it works in any interface. Edges that point at PND nodes
 * link internally; everything else shows the canonical pnd: URN.
 */
import Link from "next/link"
import { type EditionEdge, EDGE_TYPE_LABEL, pndUrn, RefKind, refToHref } from "@/lib/pnd-editions"

export function EditionGraphView({ edges }: { edges: EditionEdge[] }) {
  if (edges.length === 0) return null
  return (
    <section className="py-5 border-b border-gray-100">
      <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-400 mb-3">
        Edition graph
      </h2>
      <ul className="space-y-2">
        {edges.map((e, i) => {
          const kindChar =
            e.target.kind === RefKind.Edition ? "e" : e.target.kind === RefKind.Token ? "t" : "x"
          const urn = pndUrn(e.target.chainId, e.target.contractAddress, kindChar, e.target.id)
          const href = refToHref(e.target)
          return (
            <li key={i} className="flex items-center gap-2 text-[11px] font-mono">
              <span className="shrink-0 px-2 py-1 uppercase tracking-wider border border-gray-200 text-gray-600">
                {EDGE_TYPE_LABEL[e.edgeType]}
              </span>
              <span className="text-gray-400">→</span>
              {href ? (
                <Link href={href} className="underline hover:text-fg break-all">
                  {urn}
                </Link>
              ) : (
                <span className="text-gray-500 break-all">{urn}</span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
