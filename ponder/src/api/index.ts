import { Hono } from "hono"
import { db } from "ponder:api"
import schema from "ponder:schema"
import { graphql } from "ponder"

/**
 * HTTP surface for the Ponder service.
 *
 * Required to exist by Ponder ≥ 0.16 even if we don't expose anything
 * over HTTP. Today the web app queries Postgres directly (via postgres.js)
 * rather than going through this endpoint, so the only thing here is a
 * `/graphql` route for ad-hoc inspection during development.
 *
 * Hosted on Railway under the ponder service. Reachable at the service's
 * public domain (which we don't expose to the wider internet — only
 * useful from a developer's laptop).
 */

const app = new Hono()

app.get("/", (c) =>
  c.json({
    name: "@pin/ponder",
    description:
      "PND auction indexer. Query GraphQL at /graphql for ad-hoc inspection.",
  }),
)

// GraphQL is the canonical Ponder dev endpoint. Schema is auto-derived
// from ponder.schema.ts so any new tables are queryable without code
// changes here.
app.use("/graphql", graphql({ db, schema }))

export default app
