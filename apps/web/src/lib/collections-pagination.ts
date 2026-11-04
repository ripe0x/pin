/**
 * Pure paging math for the /collections browse index (issue #262). Kept
 * free of server-only imports so it is unit-testable.
 */

/** Collections per index page. */
export const COLLECTIONS_PAGE_SIZE = 24

/** Parse a `?page=` search param into a 1-based page number. Anything that
 *  is not a positive integer (missing, "0", "-2", "abc", "2.5", an array
 *  from a repeated param) reads as page 1. */
export function parsePageParam(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value || !/^\d+$/.test(value)) return 1
  const n = Number.parseInt(value, 10)
  return Number.isSafeInteger(n) && n >= 1 ? n : 1
}

/** OFFSET for a 1-based page. */
export function pageOffset(page: number, pageSize: number = COLLECTIONS_PAGE_SIZE): number {
  return (Math.max(1, page) - 1) * pageSize
}

/** Total pages for `total` rows; never less than 1 so an empty index still
 *  reads "page 1 of 1". */
export function totalPages(total: number, pageSize: number = COLLECTIONS_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize))
}

/** The /collections URL for a page; page 1 is the bare path so there is one
 *  canonical URL for the first page. */
export function collectionsPageHref(page: number): string {
  return page <= 1 ? "/collections" : `/collections?page=${page}`
}

export type PageNav = {
  page: number
  totalPages: number
  /** Href of the newer (previous) page, null on page 1. */
  newerHref: string | null
  /** Href of the older (next) page, null on the last page. */
  olderHref: string | null
}

/** Newer/older links for a page. A page past the end (a stale link after
 *  collections were hidden) links back to the last real page. */
export function pageNav(page: number, total: number, pageSize: number = COLLECTIONS_PAGE_SIZE): PageNav {
  const pages = totalPages(total, pageSize)
  const current = Math.max(1, page)
  return {
    page: current,
    totalPages: pages,
    newerHref: current > 1 ? collectionsPageHref(Math.min(current - 1, pages)) : null,
    olderHref: current < pages ? collectionsPageHref(current + 1) : null,
  }
}
