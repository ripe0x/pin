#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import { main } from "../src/node/cli.ts"

main(process.argv.slice(2)).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
