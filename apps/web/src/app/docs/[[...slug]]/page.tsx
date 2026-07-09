import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import content from "@/lib/docs/content.json"
import manifest from "@/lib/docs/manifest.json"
import { DocClient } from "../DocClient"

interface TocEntry {
  depth: number
  text: string
  id: string
}
interface RenderedPage {
  section: string
  slug: string
  title: string
  description: string
  html: string
  toc: TocEntry[]
}

const CONTENT = content as unknown as Record<string, RenderedPage>
const DEFAULT_KEY = "introduction/overview"

/** Flat page order across all groups + sections, for prev/next links. */
const ORDER: { path: string; title: string }[] = manifest.groups.flatMap((g) =>
  g.sections.flatMap((s) => s.items.map((i) => ({ path: i.path, title: i.title }))),
)

function keyFor(slug?: string[]): string {
  return slug && slug.length > 0 ? slug.join("/") : DEFAULT_KEY
}

export function generateStaticParams(): { slug: string[] }[] {
  return Object.keys(CONTENT).map((k) => ({ slug: k.split("/") }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug?: string[] }>
}): Promise<Metadata> {
  const { slug } = await params
  const page = CONTENT[keyFor(slug)]
  if (!page) return {}
  return { title: page.title, description: page.description }
}

export default async function DocPage({
  params,
}: {
  params: Promise<{ slug?: string[] }>
}) {
  const { slug } = await params
  const key = keyFor(slug)
  const page = CONTENT[key]
  if (!page) notFound()

  const path = `/docs/${key}`
  const idx = ORDER.findIndex((p) => p.path === path)
  const prev = idx > 0 ? ORDER[idx - 1] : null
  const next = idx >= 0 && idx < ORDER.length - 1 ? ORDER[idx + 1] : null

  return (
    <div className="doc-layout">
      <article>
        <div className="doc-body" dangerouslySetInnerHTML={{ __html: page.html }} />
        <nav className="doc-pagenav">
          {prev ? (
            <Link href={prev.path}>
              <span>Previous</span>
              {prev.title}
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link href={next.path} className="doc-pagenav-next">
              <span>Next</span>
              {next.title}
            </Link>
          ) : null}
        </nav>
      </article>

      {page.toc.length > 0 ? (
        <aside className="doc-toc" aria-label="On this page">
          <div className="doc-toc-title">On this page</div>
          {page.toc.map((t) => (
            <a key={t.id} href={`#${t.id}`} data-depth={t.depth}>
              {t.text}
            </a>
          ))}
        </aside>
      ) : null}

      <DocClient slug={key} />
    </div>
  )
}
