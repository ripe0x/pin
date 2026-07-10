# Vendored scripty v2 interfaces

These files are vendored (copied, not a Foundry lib dependency) from:

- Source repo (local path used for copy): `/Users/dd/Sites/scripty.sol`
- Upstream: https://github.com/intartnft/scripty.sol
- Commit hash: `83b850dff16ff6c82a02df601db5021a5688cc43`

Only the minimal interface + struct definitions needed for another
contract to call an already-deployed `ScriptyBuilderV2` are included:

- `interfaces/IScriptyBuilderV2.sol`
- `interfaces/IScriptyHTML.sol`
- `interfaces/IScriptyHTMLURLSafe.sol`
- `core/ScriptyStructs.sol` (`HTMLRequest`, `HTMLTag`, `HTMLTagType`)

No implementation contracts (`ScriptyCore.sol`, `ScriptyBuilderV2.sol`,
`ScriptyHTML.sol`, `ScriptyHTMLURLSafe.sol`, storage contracts, etc.)
are vendored here, and scripty is intentionally NOT added as a
`lib/` dependency.

Original license headers (`SPDX-License-Identifier: MIT`) are preserved
in each file. Upstream license: MIT (Copyright (c) 2023 @xtremetom
@0xdude), see the source repo's `MIT-LICENSE.txt`.

One import was adjusted from the upstream original: `IScriptyHTML.sol`
and `IScriptyHTMLURLSafe.sol` upstream import the `HTMLRequest` /
`HTMLTagType` / `HTMLTag` types from `./../core/ScriptyCore.sol` (which
itself imports them from `ScriptyStructs.sol`). Since `ScriptyCore.sol`
is an implementation contract and is deliberately not vendored here,
both imports were repointed directly at `./../core/ScriptyStructs.sol`,
the file that actually declares these types. No other changes were made.
