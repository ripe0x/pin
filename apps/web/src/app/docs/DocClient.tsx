"use client"

import { useEffect } from "react"

/** Wires the copy buttons the generator emits inside each `.doc-code` block,
 *  and a light scroll-spy that marks the active `.doc-toc` link. Runs after
 *  every navigation via the `slug` key so it rebinds on the new article. */
export function DocClient({ slug }: { slug: string }) {
  useEffect(() => {
    const cleanups: Array<() => void> = []

    // Copy buttons.
    document.querySelectorAll<HTMLButtonElement>(".doc-code .doc-copy").forEach((btn) => {
      const code = btn.parentElement?.querySelector<HTMLElement>(".shiki")
      if (!code) return
      const onClick = async () => {
        try {
          await navigator.clipboard.writeText(code.innerText)
          const prev = btn.textContent
          btn.textContent = "copied"
          window.setTimeout(() => {
            btn.textContent = prev
          }, 1200)
        } catch {
          /* clipboard blocked; ignore */
        }
      }
      btn.addEventListener("click", onClick)
      cleanups.push(() => btn.removeEventListener("click", onClick))
    })

    // Scroll-spy for the right-rail TOC.
    const tocLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>(".doc-toc a"))
    if (tocLinks.length > 0) {
      const byId = new Map(tocLinks.map((a) => [a.getAttribute("href")?.slice(1) ?? "", a]))
      const headings = Array.from(
        document.querySelectorAll<HTMLElement>(".doc-body h2, .doc-body h3"),
      )
      const observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              tocLinks.forEach((a) => a.removeAttribute("data-active"))
              byId.get(e.target.id)?.setAttribute("data-active", "true")
            }
          }
        },
        { rootMargin: "-64px 0px -70% 0px", threshold: 0 },
      )
      headings.forEach((h) => observer.observe(h))
      cleanups.push(() => observer.disconnect())
    }

    return () => cleanups.forEach((fn) => fn())
  }, [slug])

  return null
}
