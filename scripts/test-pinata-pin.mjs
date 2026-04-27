#!/usr/bin/env node
/**
 * Diagnostic: test Pinata pinByHash against real CIDs from the failing users.
 * Pins 3 test CIDs, reports exactly what Pinata returns, then unpins them
 * so the user doesn't burn quota.
 *
 * Usage:
 *   PINATA_JWT="eyJ..." node scripts/test-pinata-pin.mjs
 */

const JWT = process.env.PINATA_JWT
if (!JWT) {
  console.error("Set PINATA_JWT env var to your Pinata JWT token.")
  process.exit(1)
}

const API = "https://api.pinata.cloud"
const HEADERS = {
  Authorization: `Bearer ${JWT}`,
  "Content-Type": "application/json",
}

// Three CIDs from snerko + sonofGod's tokens
const TEST_CIDS = [
  { cid: "QmcsiH9kdVrJz5tFkU7qAxUqt1TjtBAbFgosy6QwFLPpqj", label: "snerko metadata #1" },
  { cid: "Qmdhs5yAF2UqBf8De3Ate9MfyGsvwSatWQuSV4TesU3oue", label: "sonofGod metadata #1" },
  { cid: "QmeSntvFCUaMZTb6hqskBqiQhD4RohYK7J5BvLPYMtQvnW", label: "sonofGod media #1 (nft.png)" },
]

async function main() {
  console.log("=== 1. Validate key ===")
  const authRes = await fetch(`${API}/data/testAuthentication`, { headers: HEADERS })
  console.log(`Status: ${authRes.status}`)
  console.log(`Body: ${(await authRes.text()).slice(0, 200)}`)
  console.log()

  console.log("=== 2. Check plan / quota ===")
  const userRes = await fetch(`${API}/users/pinPolicy`, { headers: HEADERS }).catch(() => null)
  if (userRes) {
    console.log(`Status: ${userRes.status}`)
    console.log(`Body: ${(await userRes.text()).slice(0, 300)}`)
  }
  console.log()

  const requestIds = []

  for (const { cid, label } of TEST_CIDS) {
    console.log(`=== 3. Try pinByHash: ${label} (${cid}) ===`)
    const res = await fetch(`${API}/pinning/pinByHash`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        hashToPin: cid,
        pinataMetadata: { name: `TEST: ${label}` },
      }),
    })
    const status = res.status
    const body = await res.text()
    console.log(`Status: ${status}`)
    console.log(`Body: ${body.slice(0, 400)}`)

    // Capture id so we can unpin
    try {
      const json = JSON.parse(body)
      if (json.id) requestIds.push({ id: json.id, cid, label })
    } catch {}
    console.log()
  }

  // Also try PSA (modern) endpoint as a comparison
  console.log("=== 4. Try PSA endpoint (/psa/pins) for comparison ===")
  const psaRes = await fetch(`${API}/psa/pins`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      cid: TEST_CIDS[0].cid,
      name: `TEST PSA: ${TEST_CIDS[0].label}`,
    }),
  })
  console.log(`Status: ${psaRes.status}`)
  console.log(`Body: ${(await psaRes.text()).slice(0, 400)}`)
  console.log()

  // Cleanup: unpin everything we queued
  if (requestIds.length > 0) {
    console.log("=== 5. Cleanup (unpin test CIDs) ===")
    for (const { id, cid, label } of requestIds) {
      // Unpin by CID (the canonical way)
      const unpinRes = await fetch(`${API}/pinning/unpin/${cid}`, {
        method: "DELETE",
        headers: HEADERS,
      })
      console.log(`Unpin ${label}: ${unpinRes.status}`)
    }
  }
}

main().catch((err) => {
  console.error("Test failed:", err)
  process.exit(1)
})
