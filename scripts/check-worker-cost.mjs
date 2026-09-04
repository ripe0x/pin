#!/usr/bin/env node
import postgres from "postgres"

function numberArg(name, fallback, { min = 0, max = Infinity } = {}) {
  const prefix = `--${name}=`
  const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  const value = Number(raw ?? fallback)
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`)
  }
  return value
}

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error("DATABASE_URL is required")
  process.exit(2)
}

const thresholds = {
  days: numberArg("days", process.env.WORKER_COST_DAYS ?? 7, { min: 1, max: 90 }),
  maxRpcPerDay: numberArg(
    "max-rpc-per-day",
    process.env.WORKER_COST_MAX_RPC_PER_DAY ?? 50_000,
    { min: 1 },
  ),
  maxRpcPerScope: numberArg(
    "max-rpc-per-scope",
    process.env.WORKER_COST_MAX_RPC_PER_SCOPE ?? 100,
    { min: 0 },
  ),
  maxIterationRpc: numberArg(
    "max-iteration-rpc",
    process.env.WORKER_COST_MAX_ITERATION_RPC ?? 10_000,
    { min: 1 },
  ),
  maxErrorRate: numberArg(
    "max-error-rate",
    process.env.WORKER_COST_MAX_ERROR_RATE ?? 0.05,
    { min: 0, max: 1 },
  ),
}

const sql = postgres(databaseUrl, {
  ssl: "prefer",
  prepare: false,
  max: 1,
  connect_timeout: 10,
})

try {
  const rows = await sql`
    WITH daily AS (
      SELECT day, task, iterations, errors, scope_count, rpc_calls,
             rows_written, duration_ms
      FROM worker_daily_metrics
      WHERE day >= CURRENT_DATE - (${thresholds.days}::int - 1)
    ), raw AS (
      SELECT started_at::date AS day, task, COUNT(*)::bigint AS iterations,
             COUNT(*) FILTER (WHERE NOT ok)::bigint AS errors,
             SUM(scope_count)::bigint AS scope_count,
             SUM(rpc_calls)::bigint AS rpc_calls,
             SUM(rows_written)::bigint AS rows_written,
             SUM(
               EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000
             )::bigint AS duration_ms
      FROM worker_iterations i
      WHERE started_at >= CURRENT_DATE - (${thresholds.days}::int - 1)
        AND NOT EXISTS (
          SELECT 1 FROM worker_daily_metrics d
          WHERE d.day = i.started_at::date AND d.task = i.task
        )
      GROUP BY started_at::date, task
    )
    SELECT * FROM daily UNION ALL SELECT * FROM raw
    ORDER BY day, task
  `
  const spikes = await sql`
    SELECT task, started_at, rpc_calls
    FROM worker_iterations
    WHERE started_at >= NOW() - (${thresholds.days}::text || ' days')::interval
      AND rpc_calls > ${thresholds.maxIterationRpc}
    ORDER BY rpc_calls DESC
  `

  const violations = []
  const perDay = new Map()
  for (const row of rows) {
    const rpc = Number(row.rpc_calls)
    const scopes = Number(row.scope_count)
    const iterations = Number(row.iterations)
    const errors = Number(row.errors)
    const day = String(row.day).slice(0, 10)
    perDay.set(day, (perDay.get(day) ?? 0) + rpc)
    if (iterations > 0 && errors / iterations > thresholds.maxErrorRate) {
      violations.push(`${day} ${row.task}: error rate ${(errors / iterations).toFixed(3)}`)
    }
    if (scopes > 0 && rpc / scopes > thresholds.maxRpcPerScope) {
      violations.push(`${day} ${row.task}: ${(rpc / scopes).toFixed(2)} RPC/scope`)
    }
  }
  for (const [day, rpc] of perDay) {
    if (rpc > thresholds.maxRpcPerDay) {
      violations.push(`${day}: ${rpc} total RPC calls`)
    }
  }
  for (const spike of spikes) {
    violations.push(
      `${new Date(spike.started_at).toISOString()} ${spike.task}: ` +
        `${spike.rpc_calls} RPC calls in one iteration`,
    )
  }

  console.log(
    JSON.stringify(
      {
        ok: violations.length === 0,
        thresholds,
        observedDays: perDay.size,
        taskDays: rows.length,
        violations,
      },
      null,
      2,
    ),
  )
  process.exitCode = violations.length === 0 ? 0 : 1
} catch (error) {
  console.error(`Worker cost check failed: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 2
} finally {
  await sql.end({ timeout: 5 })
}
