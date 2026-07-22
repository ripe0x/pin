import { NextRequest, NextResponse } from "next/server"

// Punk holdings for one address, proxied from the CryptoPunks app's account API.
// One upstream call returns every punk the address holds, raw and wrapped, with a
// `wrapped` flag per entry — this is what HomageMinter._isPunkHolder checks
// onchain (raw via punkIndexToAddress, wrapped via the wrapper contract). Replaces
// a client-side eth_getLogs acquisition scan bounded to a recent block window,
// which misses any punk that hasn't moved inside that window.
//
// Discovery only: HomageMinter re-verifies ownership onchain at mint, so a stale,
// empty, or failed response can't mint to the wrong wallet — the picker just comes
// up short and the caller falls back to the log-scan path or manual id entry.
//
// Mainnet-only. cryptopunks.app tracks mainnet punk state; there is no sepolia
// equivalent, so this route must not be called when the app is pointed at the
// sepolia/fork test instances (see NEXT_PUBLIC_USE_SEPOLIA / NEXT_PUBLIC_USE_LOCAL_RPC
// gating in src/lib/homage/punks.ts).
//
// Cached at the CDN (s-maxage) and at the fetch layer (revalidate) so concurrent
// requests for the same address collapse to one upstream call per window.

const UPSTREAM = "https://www.cryptopunks.app/api/account"
const TTL_SECONDS = 60
// The upstream edge returns 403 without a browser-like User-Agent.
const UPSTREAM_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

type OwnedPunk = { index: number; wrapped: boolean }

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ ok: false, punks: [] as OwnedPunk[], error: "bad address" }, { status: 400 })
  }

  try {
    const res = await fetch(`${UPSTREAM}/${address.toLowerCase()}?owned=true`, {
      headers: { "user-agent": UPSTREAM_UA, accept: "application/json" },
      next: { revalidate: TTL_SECONDS },
    })
    if (!res.ok) {
      // Soft-fail: the caller treats this as "discovery unavailable" and falls back.
      return NextResponse.json(
        { ok: false, punks: [] as OwnedPunk[] },
        { headers: { "cache-control": "public, s-maxage=15" } },
      )
    }
    const body = (await res.json()) as { data?: { owned?: Array<{ index: number; wrapped?: boolean }> } }
    const punks: OwnedPunk[] = (body.data?.owned ?? [])
      .filter((p) => Number.isInteger(p.index) && p.index >= 0 && p.index <= 9999)
      .map((p) => ({ index: p.index, wrapped: !!p.wrapped }))
    return NextResponse.json(
      { ok: true, punks },
      { headers: { "cache-control": `public, s-maxage=${TTL_SECONDS}, stale-while-revalidate=300` } },
    )
  } catch {
    return NextResponse.json(
      { ok: false, punks: [] as OwnedPunk[] },
      { headers: { "cache-control": "public, s-maxage=15" } },
    )
  }
}
