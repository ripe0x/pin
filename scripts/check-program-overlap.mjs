import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, "..")
const state = JSON.parse(fs.readFileSync(path.join(repoRoot, "docs/program-state.json"), "utf8"))
const asJson = process.argv.includes("--json")
const failOnOverlap = process.argv.includes("--fail-on-overlap")

function run(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim()
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || error?.message || "unknown error"
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`)
  }
}

function lines(value) {
  return value ? value.split("\n").map((line) => line.trim()).filter(Boolean) : []
}

const branch = run("git", ["branch", "--show-current"])
const committedFiles = lines(run("git", ["diff", "--name-only", "origin/main...HEAD"]))
const workingFiles = lines(run("git", ["status", "--porcelain"])).map((line) => {
  const name = line.slice(3)
  return name.includes(" -> ") ? name.split(" -> ").at(-1) : name
})
const currentFiles = new Set([...committedFiles, ...workingFiles])

const referencedPrs = new Set(state.workstreams.flatMap((workstream) => workstream.pullRequests ?? []))
const openPrs = JSON.parse(run("gh", [
  "pr", "list", "--repo", state.github.repository, "--state", "open", "--limit", "200",
  "--json", "number,title,headRefName,url"
])).filter((pr) => referencedPrs.has(pr.number) && pr.headRefName !== branch)

const overlaps = []
for (const pr of openPrs) {
  const prFiles = lines(run("gh", [
    "api", `repos/${state.github.repository}/pulls/${pr.number}/files`, "--paginate", "--jq", ".[].filename"
  ]))
  const shared = prFiles.filter((file) => currentFiles.has(file)).sort()
  if (shared.length) overlaps.push({ ...pr, files: shared })
}

const result = {
  branch,
  comparedFileCount: currentFiles.size,
  referencedOpenPullRequestCount: openPrs.length,
  overlaps
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`program-overlap: ${branch || "detached"} changes ${currentFiles.size} files against origin/main`)
  if (!overlaps.length) {
    console.log("program-overlap: no shared files with referenced open pull requests")
  } else {
    for (const overlap of overlaps) {
      console.log(`\nPR #${overlap.number}: ${overlap.title}`)
      console.log(`branch: ${overlap.headRefName}`)
      for (const file of overlap.files) console.log(`  ${file}`)
    }
  }
}

if (failOnOverlap && overlaps.length) process.exitCode = 1

