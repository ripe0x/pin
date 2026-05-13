#!/usr/bin/env node
/**
 * Ensures apps/web/.env.local exists in this checkout. When running inside
 * a git worktree (e.g. .claude/worktrees/<branch>/), git ignores .env.local
 * so a fresh worktree has no env file, the dev server runs without
 * DATABASE_URL / ALCHEMY_API_KEY, and the homepage feed silently falls back
 * to "feed temporarily unavailable".
 *
 * This script runs before `next dev` and symlinks .env.local from the main
 * checkout (located via `git rev-parse --git-common-dir`). No-op when
 * .env.local already exists.
 */
import { execSync } from "node:child_process"
import { existsSync, symlinkSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const webDir = resolve(here, "..")
const target = resolve(webDir, ".env.local")

if (existsSync(target)) process.exit(0)

let commonDir
try {
  commonDir = execSync("git rev-parse --git-common-dir", {
    cwd: webDir,
    encoding: "utf8",
  }).trim()
} catch {
  process.exit(0)
}

const gitDir = execSync("git rev-parse --git-dir", {
  cwd: webDir,
  encoding: "utf8",
}).trim()

// In a worktree, --git-dir points at .git/worktrees/<name> while
// --git-common-dir points at the main repo's .git. When they match
// we're in the main checkout — nothing to symlink to.
if (resolve(webDir, gitDir) === resolve(webDir, commonDir)) process.exit(0)

// commonDir is "<main>/.git" (absolute or relative-to-webDir). The main
// repo root is its parent, and the source env file mirrors our own path.
const mainRepo = resolve(webDir, commonDir, "..")
const source = resolve(mainRepo, "apps/web/.env.local")

if (!existsSync(source)) {
  console.warn(
    `[ensure-env-local] no env file found at ${source}; dev server will run without it`,
  )
  process.exit(0)
}

symlinkSync(source, target)
console.log(`[ensure-env-local] linked ${target} -> ${source}`)
