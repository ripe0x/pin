import {NextRequest, NextResponse} from "next/server"
import {getAddress, isAddress} from "viem"

// ENS resolution for the homage allowlist checker, offloaded to a hosted service so the
// browser (and our infra) make ZERO RPC calls. ensideas is primary (both directions on one
// endpoint, Cloudflare-cached ~60ms); ensdata is the fallback if ensideas is unreachable.
// The on-chain allowlistMint still verifies by address, so a bad/failed resolve here can
// never admit anyone wrongly; this is display/convenience only, kept off the mint path.

type EnsResult = {address: string | null; name: string | null; displayName: string | null; source?: string}

const TIMEOUT_MS = 6000
const truncate = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, {signal: ctrl.signal, headers: {accept: "application/json"}})
    return r.ok ? ((await r.json()) as Record<string, unknown>) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function normalizeAddress(v: unknown): string | null {
  return typeof v === "string" && isAddress(v) ? getAddress(v) : null
}

async function viaEnsideas(q: string): Promise<EnsResult | null> {
  const j = await fetchJson(`https://api.ensideas.com/ens/resolve/${encodeURIComponent(q)}`)
  if (!j) return null
  const address = normalizeAddress(j.address)
  const name = typeof j.name === "string" ? j.name : null
  const displayName = typeof j.displayName === "string" ? j.displayName : name ?? (address ? truncate(address) : null)
  return {address, name, displayName, source: "ensideas"}
}

async function viaEnsdata(q: string): Promise<EnsResult | null> {
  const j = await fetchJson(`https://api.ensdata.net/${encodeURIComponent(q)}`)
  if (!j) return null
  const address = normalizeAddress(j.address)
  const name = typeof j.ens === "string" ? j.ens : typeof j.name === "string" ? j.name : null
  return {address, name, displayName: name ?? (address ? truncate(address) : null), source: "ensdata"}
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim()
  if (!q) return NextResponse.json({error: "missing q"}, {status: 400})

  const result = (await viaEnsideas(q)) ?? (await viaEnsdata(q))
  if (!result) {
    // Both services unreachable; signal so the client can fall back to "paste an address".
    return NextResponse.json({address: null, name: null, displayName: null, error: "unavailable"}, {status: 503})
  }
  return NextResponse.json(result, {
    headers: {"cache-control": "public, s-maxage=86400, stale-while-revalidate=604800"},
  })
}
