"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"

interface ManifestItem {
  title: string
  slug: string
  path: string
  description: string
}
interface ManifestSection {
  id: string
  title: string
  items: ManifestItem[]
}
interface ManifestGroup {
  id: string
  title: string
  sections: ManifestSection[]
}
interface Manifest {
  title: string
  groups: ManifestGroup[]
}

export function DocsSidebar({ manifest }: { manifest: Manifest }) {
  const pathname = usePathname()
  const [navOpen, setNavOpen] = useState(false)
  // Groups are collapsible; all default open. Scales as protocols are added.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  return (
    <nav className="doc-sidebar" aria-label="Documentation">
      <button
        type="button"
        className="doc-sidebar-toggle"
        aria-expanded={navOpen}
        onClick={() => setNavOpen((v) => !v)}
      >
        {manifest.title} {navOpen ? "▾" : "▸"}
      </button>
      <div className="doc-sidebar-nav" data-collapsed={!navOpen}>
        {manifest.groups
          .filter((g) => g.sections.some((s) => s.items.length > 0))
          .map((group) => {
            const isCollapsed = collapsed[group.id] ?? false
            return (
              <div key={group.id} className="doc-sidebar-group">
                <button
                  type="button"
                  className="doc-sidebar-group-title"
                  aria-expanded={!isCollapsed}
                  onClick={() =>
                    setCollapsed((c) => ({ ...c, [group.id]: !isCollapsed }))
                  }
                >
                  {group.title}
                  <span className="doc-sidebar-group-chevron">{isCollapsed ? "▸" : "▾"}</span>
                </button>
                {!isCollapsed &&
                  group.sections
                    .filter((s) => s.items.length > 0)
                    .map((section) => (
                      <div key={section.id} className="doc-sidebar-section">
                        {section.title ? (
                          <div className="doc-sidebar-section-title">{section.title}</div>
                        ) : null}
                        <ul className="doc-sidebar-list">
                          {section.items.map((item) => (
                            <li key={item.path}>
                              <Link
                                href={item.path}
                                className="doc-sidebar-link"
                                aria-current={pathname === item.path ? "page" : undefined}
                                onClick={() => setNavOpen(false)}
                              >
                                {item.title}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
              </div>
            )
          })}
      </div>
    </nav>
  )
}
