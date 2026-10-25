import { sql } from "@/lib/db"
import { captureImageResponse, parseCaptureImagePath } from "@/lib/capture-image"

export const runtime = "nodejs"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ chainId: string; collection: string; file: string }> },
) {
  const { chainId, collection, file } = await params
  const path = parseCaptureImagePath(chainId, collection, file)
  if (!path || !sql) return captureImageResponse(undefined)
  try {
    // Only a configured capture stream has a cover; unknown collections 404.
    const [row] = await sql`
      SELECT s.cover_uri, j.png, j.sha256
      FROM capture_streams s
      LEFT JOIN capture_jobs j ON j.chain_id = s.chain_id AND j.collection = s.collection
        AND j.token_id = ${path.tokenId} AND j.png IS NOT NULL
      WHERE s.chain_id = ${path.chainId} AND s.collection = ${path.collection}`
    return captureImageResponse(row as Parameters<typeof captureImageResponse>[0])
  } catch (error) {
    // Web and worker migrate independently: no capture tables yet is a 404.
    if ((error as { code?: string })?.code === "42P01") return captureImageResponse(undefined)
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } })
  }
}
