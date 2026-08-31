import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, "..")
const statePath = path.join(repoRoot, "docs/program-state.json")

function fail(message) {
  console.error(`program-state: ${message}`)
  process.exitCode = 1
}

function assert(condition, message) {
  if (!condition) fail(message)
}

const state = JSON.parse(fs.readFileSync(statePath, "utf8"))

assert(state.schemaVersion === 1, "schemaVersion must be 1")
assert(typeof state.programId === "string" && state.programId.length > 0, "programId is required")
assert(/^\d{4}-\d{2}-\d{2}$/.test(state.updatedAt), "updatedAt must be YYYY-MM-DD")

for (const [name, relativePath] of Object.entries(state.canonicalDocs ?? {})) {
  assert(typeof relativePath === "string", `canonicalDocs.${name} must be a path`)
  if (typeof relativePath === "string") {
    assert(fs.existsSync(path.join(repoRoot, relativePath)), `canonicalDocs.${name} does not exist: ${relativePath}`)
  }
}

for (const relativePath of state.decisions ?? []) {
  assert(typeof relativePath === "string", "decision references must be paths")
  if (typeof relativePath === "string") {
    assert(fs.existsSync(path.join(repoRoot, relativePath)), `decision does not exist: ${relativePath}`)
  }
}

const invariantIds = new Set()
for (const invariant of state.invariants ?? []) {
  assert(!invariantIds.has(invariant.id), `duplicate invariant id ${invariant.id}`)
  invariantIds.add(invariant.id)
  assert(typeof invariant.statement === "string" && invariant.statement.length > 0, `${invariant.id} needs a statement`)
  const sourcePath = String(invariant.source ?? "").split("#")[0]
  assert(sourcePath.length > 0 && fs.existsSync(path.join(repoRoot, sourcePath)), `${invariant.id} source does not exist: ${sourcePath}`)
}

const gateIds = new Set()
for (const gate of state.acceptanceGates ?? []) {
  assert(!gateIds.has(gate.id), `duplicate acceptance gate id ${gate.id}`)
  gateIds.add(gate.id)
  assert(typeof gate.description === "string" && gate.description.length > 0, `${gate.id} needs a description`)
}

const allowedStatuses = new Set([
  "proposed",
  "ready",
  "in_progress",
  "integrated_hidden",
  "verified_preview",
  "activated",
  "observed",
  "complete"
])

const workstreams = state.workstreams ?? []
const workstreamIds = new Set(workstreams.map((workstream) => workstream.id))
assert(workstreamIds.size === workstreams.length, "workstream ids must be unique")

const milestones = workstreams.flatMap((workstream) => workstream.milestones ?? [])
const milestoneIds = new Set(milestones.map((milestone) => milestone.id))
assert(milestoneIds.size === milestones.length, "milestone ids must be unique")

for (const workstream of workstreams) {
  assert(allowedStatuses.has(workstream.status), `${workstream.id} has invalid status ${workstream.status}`)
  assert(typeof workstream.outcome === "string" && workstream.outcome.length > 0, `${workstream.id} needs an outcome`)
  assert(typeof workstream.nextAction === "string" && workstream.nextAction.length > 0, `${workstream.id} needs one exact next action`)
  assert(Array.isArray(workstream.ownedPaths) && workstream.ownedPaths.length > 0, `${workstream.id} needs ownedPaths`)
  assert(Array.isArray(workstream.milestones) && workstream.milestones.length > 0, `${workstream.id} needs milestones`)

  for (const dependency of workstream.deliveryDependsOn ?? []) {
    assert(workstreamIds.has(dependency), `${workstream.id} has unknown delivery dependency ${dependency}`)
    assert(dependency !== workstream.id, `${workstream.id} cannot depend on itself`)
  }

  for (const gateId of workstream.acceptanceGateIds ?? []) {
    assert(gateIds.has(gateId), `${workstream.id} references unknown gate ${gateId}`)
  }
}

const visiting = new Set()
const visited = new Set()
const byId = new Map(milestones.map((milestone) => [milestone.id, milestone]))

for (const milestone of milestones) {
  assert(allowedStatuses.has(milestone.status), `${milestone.id} has invalid status ${milestone.status}`)
  assert(typeof milestone.title === "string" && milestone.title.length > 0, `${milestone.id} needs a title`)
  assert(typeof milestone.nextAction === "string" && milestone.nextAction.length > 0, `${milestone.id} needs one exact next action`)
  if (milestone.workPacket) {
    assert(fs.existsSync(path.join(repoRoot, milestone.workPacket)), `${milestone.id} work packet does not exist: ${milestone.workPacket}`)
  }
  for (const dependency of milestone.dependsOn ?? []) {
    assert(milestoneIds.has(dependency), `${milestone.id} depends on unknown milestone ${dependency}`)
    assert(dependency !== milestone.id, `${milestone.id} cannot depend on itself`)
  }
}

function visit(id) {
  if (visited.has(id)) return
  if (visiting.has(id)) {
    fail(`dependency cycle includes ${id}`)
    return
  }
  visiting.add(id)
  for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency)
  visiting.delete(id)
  visited.add(id)
}

for (const id of milestoneIds) visit(id)

const riskIds = new Set()
const allowedSeverities = new Set(["critical", "high", "medium", "low"])
for (const risk of state.risks ?? []) {
  assert(!riskIds.has(risk.id), `duplicate risk id ${risk.id}`)
  riskIds.add(risk.id)
  assert(allowedSeverities.has(risk.severity), `${risk.id} has invalid severity ${risk.severity}`)
  assert(typeof risk.condition === "string" && risk.condition.length > 0, `${risk.id} needs a condition`)
  assert(typeof risk.control === "string" && risk.control.length > 0, `${risk.id} needs a control`)
  for (const workstreamId of risk.affects ?? []) {
    assert(workstreamIds.has(workstreamId), `${risk.id} affects unknown workstream ${workstreamId}`)
  }
}

if (!process.exitCode) {
  console.log(`program-state: valid (${workstreams.length} workstreams, ${milestones.length} milestones, ${invariantIds.size} invariants, ${gateIds.size} gates, ${riskIds.size} risks)`)
}
