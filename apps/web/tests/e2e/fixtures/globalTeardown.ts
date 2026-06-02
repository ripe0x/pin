/**
 * Tears down the stack globalSetup started: kills the Next dev server and
 * Anvil process groups (both spawned detached, so they're group leaders).
 */
import { readFileSync, rmSync } from "node:fs"
import { STATE_FILE, type GlobalState } from "./globalSetup"

function killGroup(pid: number) {
  if (!pid) return
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      // already gone
    }
  }
}

export default async function globalTeardown() {
  let state: GlobalState | null = null
  try {
    state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as GlobalState
  } catch {
    return
  }
  killGroup(state.appPid)
  killGroup(state.anvilPid)
  try {
    rmSync(STATE_FILE)
  } catch {
    // ignore
  }
}
