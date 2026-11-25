// Runs findCandidates' real SQL against a real Postgres with every
// db/migrations file applied. Skipped unless TEST_DATABASE_URL is set,
// because CI has no database:
//   TEST_DATABASE_URL=postgres://... node --experimental-strip-types --test src/tasks/derive-token-media.test.ts
import { strict as assert } from "node:assert"
import { test } from "node:test"

const url = process.env.TEST_DATABASE_URL

test("derive-token-media only picks requested tokens", { skip: !url }, async (t) => {
  process.env.DATABASE_URL = url
  const { sql } = await import("../db.ts")
  const { findCandidates } = await import("./derive-token-media.ts")

  const C = "0x00000000000000000000000000000000000000aa"
  const meta = (id: string, image: string, burned = false) => sql`
    INSERT INTO token_metadata (contract, token_id, image_url, burned)
    VALUES (${C}, ${id}, ${image}, ${burned})
    ON CONFLICT (contract, token_id) DO UPDATE SET image_url = EXCLUDED.image_url, burned = EXCLUDED.burned
  `
  const request = (id: string) =>
    sql`INSERT INTO token_media_requests (contract, token_id) VALUES (${C}, ${id}) ON CONFLICT DO NOTHING`

  await sql`DELETE FROM token_media_requests WHERE contract = ${C}`
  await sql`DELETE FROM token_media_delivery WHERE contract = ${C}`
  await meta("1", "ipfs://bafy-never-viewed/1.png")
  await meta("2", "ipfs://bafy-viewed/2.png")
  await meta("3", "ipfs://bafy-viewed-burned/3.png", true)
  await meta("4", "ipfs://bafy-already-ready/4.png")
  await request("2")
  await request("3")
  await request("4")
  await sql`
    INSERT INTO token_media_delivery (contract, token_id, source_url, status, thumbnail_url)
    VALUES (${C}, '4', 'ipfs://bafy-already-ready/4.png', 'ready', 'https://cdn.example/4.webp')
  `
  t.after(async () => {
    await sql`DELETE FROM token_media_requests WHERE contract = ${C}`
    await sql`DELETE FROM token_media_delivery WHERE contract = ${C}`
    await sql`DELETE FROM token_metadata WHERE contract = ${C}`
    await sql.end()
  })

  const mine = (await findCandidates()).filter((c) => c.contract === C)
  assert.deepEqual(mine, [{ contract: C, tokenId: "2", sourceUrl: "ipfs://bafy-viewed/2.png" }])

  // A source change on a requested, already-derived token re-derives it.
  await meta("4", "ipfs://bafy-new-art/4.png")
  const rederive = (await findCandidates()).filter((c) => c.contract === C).map((c) => c.tokenId).sort()
  assert.deepEqual(rederive, ["2", "4"])
})

