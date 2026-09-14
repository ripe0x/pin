import { NextResponse, type NextRequest } from "next/server"

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

// Case-normalize the studio address segment before the layout renders.
// The layout can only see the [address] param, not the full path, so a
// checksummed deep link (/studio/0xAbC.../create?x=1) redirected there
// would lose /create and the query. Middleware sees the whole URL and
// rewrites only the address segment, keeping subpath + search intact.
// ENS / non-hex slugs are left for the layout's async resolveEnsAddress.
export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const segments = pathname.split("/") // ["", "studio", "<address>", ...rest]
  const addr = segments[2]

  if (addr && ADDRESS_RE.test(addr) && addr !== addr.toLowerCase()) {
    segments[2] = addr.toLowerCase()
    const url = request.nextUrl.clone()
    url.pathname = segments.join("/")
    url.search = search
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  matcher: "/studio/:address*",
}
