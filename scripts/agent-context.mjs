import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, "..")
const state = JSON.parse(fs.readFileSync(path.join(repoRoot, "docs/program-state.json"), "utf8"))
const online = process.argv.includes("--online")
const asJson = process.argv.includes("--json")

function run(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim()
  } catch {
    return null
  }
}

const branch = run("git", ["branch", "--show-current"])
const status = run("git", ["status", "--short"]) ?? ""
const worktrees = run("git", ["worktree", "list", "--porcelain"]) ?? ""
const mainDivergenceRaw = run("git", ["rev-list", "--left-right", "--count", "HEAD...origin/main"])
const [aheadOfOriginMain, behindOriginMain] = (mainDivergenceRaw ?? "").split(/\s+/).map(Number)

let github = null
if (online) {
  const issueJson = run("gh", [
    "issue", "list", "--repo", state.github.repository, "--state", "all", "--limit", "200",
    "--json", "number,title,state,url"
  ])
  const prJson = run("gh", [
    "pr", "list", "--repo", state.github.repository, "--state", "all", "--limit", "200",
    "--json", "number,title,state,isDraft,headRefName,url"
  ])

  if (issueJson && prJson) {
    const wantedIssues = new Set([
      ...state.workstreams.flatMap((workstream) => workstream.issues ?? []),
      ...(state.risks ?? []).map((risk) => risk.issue).filter(Boolean),
      state.github.strategyIssue,
      state.github.programIssue,
      state.github.foundationIssue
    ])
    const wantedPrs = new Set(state.workstreams.flatMap((workstream) => workstream.pullRequests ?? []))
    github = {
      issues: JSON.parse(issueJson).filter((issue) => wantedIssues.has(issue.number)),
      pullRequests: JSON.parse(prJson).filter((pr) => wantedPrs.has(pr.number))
    }
  }
}

const context = {
  program: {
    id: state.programId,
    title: state.title,
    updatedAt: state.updatedAt,
    strategyIssue: state.github.strategyIssue,
    programIssue: state.github.programIssue,
    foundationPullRequest: state.github.foundationPullRequest
  },
  git: {
    branch,
    dirty: status.length > 0,
    status: status ? status.split("\n") : [],
    aheadOfOriginMain: Number.isFinite(aheadOfOriginMain) ? aheadOfOriginMain : null,
    behindOriginMain: Number.isFinite(behindOriginMain) ? behindOriginMain : null,
    worktreeCount: worktrees.split("\n").filter((line) => line.startsWith("worktree ")).length
  },
  readOrder: [
    "AGENTS.md",
    "docs/program-state.json",
    state.canonicalDocs.programSpec,
    "ARCHITECTURE.md",
    "the owning issue, PR, and relevant source"
  ],
  workstreams: state.workstreams.map((workstream) => ({
    id: workstream.id,
    title: workstream.title,
    status: workstream.status,
    deliveryDependsOn: workstream.deliveryDependsOn,
    nextAction: workstream.nextAction,
    milestones: workstream.milestones
  })),
  executableMilestones: state.workstreams
    .flatMap((workstream) => workstream.milestones ?? [])
    .filter((milestone) => milestone.status === "ready" || milestone.status === "in_progress"),
  risks: state.risks,
  github
}

if (asJson) {
  console.log(JSON.stringify(context, null, 2))
  process.exit(0)
}

console.log(`${context.program.title} (${context.program.id})`)
console.log(`state updated: ${context.program.updatedAt}`)
console.log(`branch: ${branch || "detached"}${context.git.dirty ? " (dirty)" : " (clean)"}`)
console.log(`origin/main divergence: ahead ${context.git.aheadOfOriginMain ?? "?"}, behind ${context.git.behindOriginMain ?? "?"}`)
console.log(`registered worktrees: ${context.git.worktreeCount}`)
console.log("\nRead order:")
for (const item of context.readOrder) console.log(`  - ${item}`)
console.log("\nExecutable fronts:")
for (const milestone of context.executableMilestones) {
  console.log(`  ${milestone.id} [${milestone.status}]: ${milestone.title}`)
  if (milestone.workPacket) console.log(`     packet: ${milestone.workPacket}`)
  console.log(`     next: ${milestone.nextAction}`)
}
console.log("\nProgram graph:")
for (const workstream of context.workstreams) {
  const dependencies = workstream.deliveryDependsOn.length ? ` delivery after ${workstream.deliveryDependsOn.join(", ")}` : ""
  console.log(`  ${workstream.id} [${workstream.status}]${dependencies}: ${workstream.title}`)
  console.log(`     next: ${workstream.nextAction}`)
  for (const milestone of workstream.milestones) {
    const milestoneDependencies = milestone.dependsOn.length ? ` after ${milestone.dependsOn.join(", ")}` : ""
    console.log(`     ${milestone.id} [${milestone.status}]${milestoneDependencies}: ${milestone.title}`)
  }
}

console.log("\nActive risks:")
for (const risk of context.risks) {
  console.log(`  ${risk.id} [${risk.severity}] affects ${risk.affects.join(", ")}`)
  console.log(`     control: ${risk.control}`)
}

if (context.git.status.length) {
  console.log("\nWorking tree changes:")
  for (const line of context.git.status) console.log(`  ${line}`)
}

if (online && !github) {
  console.log("\nGitHub status unavailable. Local program state remains usable.")
} else if (github) {
  console.log("\nReferenced GitHub work:")
  for (const issue of github.issues) console.log(`  issue #${issue.number} [${issue.state}]: ${issue.title}`)
  for (const pr of github.pullRequests) console.log(`  PR #${pr.number} [${pr.isDraft ? "DRAFT " : ""}${pr.state}]: ${pr.title}`)
}
