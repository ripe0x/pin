import type { ReactNode } from "react"
import type { Metadata } from "next"
import manifest from "@/lib/docs/manifest.json"
import { DocsSidebar } from "./DocsSidebar"
import "./docs.css"

export const metadata: Metadata = {
  title: {
    default: "Collection System reference",
    template: "%s | Collection System",
  },
  description:
    "API reference for the PND Collection System: the artist-owned ERC721 core, its four swappable slots, and the contracts around it.",
}

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="doc-shell">
      <DocsSidebar manifest={manifest} />
      {children}
    </div>
  )
}
