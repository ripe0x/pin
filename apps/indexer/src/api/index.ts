import { Hono } from "hono"
import { db } from "ponder:api"
import schema from "ponder:schema"
import { graphql } from "ponder"

/**
 * Ponder ≥ 0.16 requires this file to exist even if we don't expose much
 * over HTTP. Web reads bypass this and go straight to Postgres via
 * postgres.js. GraphQL endpoint is here for ad-hoc dev inspection only.
 */

const app = new Hono()

app.get("/", (c) =>
  c.json({
    name: "@pin/indexer",
    description: "PND v2 indexer. GraphQL at /graphql for dev inspection.",
  }),
)

app.use("/graphql", graphql({ db, schema }))

export default app
