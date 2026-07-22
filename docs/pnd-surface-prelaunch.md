# PND Surface System: post-deploy → launch runbook

> **What this is.** The ordered checklist for the window between the
> immutable mainnet deploy (gated on the external re-audit) and the
> public launch. Each item carries a ready-to-paste **kickoff prompt**
> for a fresh Claude Code session in this repo, so starting any item is
> copy, paste, go. Work deferred PAST launch lives in
> `pnd-surface-post-deploy.md`. Written 2026-07-13.
>
> **Standing rules that apply to every prompt below:** never broadcast a
> mainnet transaction without Dave explicitly saying so in the task; all
> explorer links use evm.now (`https://evm.now/tx/<hash>?chainId=1`);
> minimize RPC — indexer first, cache always, no reads in render paths;
> "done" means the runtime path was exercised, not that types compile.

---

## Phase A — the hour after the deploy tx lands

### A1. Record the addresses everywhere they belong

Three places hold protocol addresses and all currently carry
placeholders: `contracts/deployments.mainnet.json` (feeds the docs
generator, which prints an unresolved-placeholder warning until filled),
`packages/addresses/src/index.ts` (`SOVEREIGN_COLLECTION_FACTORY`,
`RENDER_ASSETS`, `DEFAULT_RENDERER` — the web app's source of truth),
and the reference docs regenerate from the first.

- [ ] deployments.mainnet.json filled; `pnpm generate:docs` reports zero
      unresolved placeholders
- [ ] packages/addresses entries filled; `pnpm --filter web typecheck`
      green
- [ ] /docs pages show the real addresses

```
Prompt: You are a hands-on implementer; do this yourself. In the pnd
repo (~/foundation): the Surface system just deployed to mainnet.
Addresses: <paste factory, sequential impl, pooled impl,
DefaultRenderer, RenderAssets from the deploy broadcast>. Fill
contracts/deployments.mainnet.json and the placeholder entries in
packages/addresses/src/index.ts (SOVEREIGN_COLLECTION_FACTORY,
RENDER_ASSETS, DEFAULT_RENDERER). Run pnpm generate:docs and confirm
the unresolved-placeholder warning is gone, then pnpm --filter web
typecheck. Cross-check each address against the deploy broadcast in
contracts/broadcast/ before writing it anywhere. No transactions.
```

### A2. Verify contract source on the explorers

Immutable contracts that people are asked to trust must be readable.

- [ ] Factory, both implementations, DefaultRenderer, RenderAssets
      verified (Etherscan + Sourcify)
- [ ] Clones resolve readably (EIP-1167 auto-detection points at the
      verified implementation)

```
Prompt: You are a hands-on implementer; do this yourself. In the pnd
repo (~/foundation/contracts): verify the just-deployed collection
contracts on Etherscan and Sourcify with forge verify-contract
(constructor args from the broadcast files in contracts/broadcast/).
Contracts + addresses: <paste>. Compiler settings come from
foundry.toml — do not guess them. Confirm each shows verified source,
and that a clone address resolves to the implementation's readable
source via EIP-1167 detection. Read-only + verification API calls; no
transactions.
```

## Phase B — the same day: make collections visible

### B1. Enable discovery indexing (prep is doable before deploy)

Ponder subscribes by address, so this could not ship pre-deploy — but
nothing is lost: `SurfaceCreated` events backfill from the factory's
deploy block whenever the subscription lands. This is the blessed
fixed-contract Ponder case per `AGENTS.md` (one factory, one event, no
long tail). Do NOT put per-token scanning in Ponder.

- [ ] (prep, pre-deploy ok) handler written with the address
      parameterized
- [ ] factory subscription live in `apps/indexer/ponder.config.ts`,
      start block = deploy block
- [ ] backfill verified: indexed rows match `totalSurfaces()` on the
      factory

```
Prompt: You are a hands-on implementer; do this yourself. In the pnd
repo (~/foundation): add discovery indexing for the collection factory.
Read AGENTS.md first — Ponder is discovery-only, and this is the
fixed-contract case it blesses. Add a SurfaceCreated subscription
for the factory (address <paste>, start block <deploy block>) to
apps/indexer/ponder.config.ts with a handler in apps/indexer/src/
writing one row per collection (owner, collection address, idMode,
block/tx) to the ponder_v1 schema, following the existing pnd_*/fnd_*
handler patterns. The ABI is already exported from @pin/abi
(surfaceFactoryAbi) and mirrored in apps/indexer/abis/. Verify
against local dev: run the indexer, confirm the backfilled row count
equals the factory's totalSurfaces() (one eth_call), and confirm
zero ongoing RPC beyond the subscription. Do not add per-token
indexing.
```

### B2. Wire the web surfaces to the indexed table

- [ ] discovery/browse surface reads the collections table (Postgres
      only — zero chain reads in the list path)
- [ ] studio "your collections" lists from the same table
- [ ] `isCollection` checks on mint pages use the indexed set, not a
      live factory read

```
Prompt: You are a hands-on implementer; do this yourself. In the pnd
repo (~/foundation): wire the collection discovery surfaces in apps/web
to the newly indexed collections table (ponder_v1, written by the
SurfaceCreated handler). Read AGENTS.md + apps/web/src/lib/reads.ts
first: web reads Postgres ONLY for storable data. List pages must be
pure SELECTs — no chain reads in any list/render path; per-collection
live state (price, status) stays behind the existing cached-read
helpers in apps/web/src/lib/collection-onchain.ts. Update the studio
"your collections" view to filter the same table by owner. Exercise
both pages against local dev with a seeded collection
(contracts/script/SeedDevSurfaces.s.sol + scripts/dev-collections.sh)
before calling it done, and link the local URLs you tested.
```

## Phase C — the launch collection itself

### C3. Deploy the launch renderer + collection (scripted, Dave broadcasts)

The studio wizard is not the launch path; scripts are. Every broadcast
is Dave's call, one confirm per transaction.

- [ ] launch renderer deployed + verified; born-locked flags decided
      (`rendererLocked` at create pins it from block one)
- [ ] collection created via factory with the real config (price, cap,
      window, royalty, payout)
- [ ] `tokenURI` renders correctly via `cast call` before anything mints

```
Prompt: You are a hands-on implementer; do this yourself. In the pnd
repo (~/foundation/contracts): prepare (do NOT broadcast) the launch
deploy: the project renderer, then createSurface on the factory
(<address>) with the launch config <paste: name/symbol/owner/price/
cap/window/royalty/payout/rendererLocked/supplyLocked/creators>.
Dry-run the full sequence on a mainnet fork first (anvil --fork-url
https://ethereum-rpc.publicnode.com) and paste the resulting tokenURI
output rendered from the fork. Then stage the mainnet commands and stop:
every broadcast needs Dave's explicit go, one AskUserQuestion per
transaction, with pre-flight reads per the mainnet protocol. Post-tx,
verify source (see runbook A2) and re-run the tokenURI cast call
against mainnet.
```

### C4. Attribution handshake + cover

- [ ] creators listed on the collection (`setCreators`, if not passed at
      create)
- [ ] artist claims the collection in Catalog → `isConfirmedCreator`
      returns true
- [ ] cover set in RenderAssets → `contractURI` carries it (marketplace
      collection page)

```
Prompt: You are a hands-on implementer; do this yourself. In the pnd
repo (~/foundation): complete the launch collection's attribution
handshake and cover. Collection <address>, artist <address>. Check
isListedCreator/isConfirmedCreator via cast call; if the creator list
was not set at create, stage setCreators; stage the artist's Catalog
addContract claim (the artist signs); stage RenderAssets.setCover
(registry <address>) with the cover URI <paste — one-time permanent
storage per docs/pnd-surface-thumbnails.md §2>. Dry-run each on a
fork, then stop — Dave broadcasts, one confirm per tx. Afterward verify
isConfirmedCreator == true and decode contractURI to confirm the cover
is in it.
```

### C5. Mainnet smoke test — the money path and the marketplace path

The pull-payment path and the marketplace presentation have only been
exercised in tests and forks; before launch, exercise them once with
real value, small.

- [ ] one real mint (Dave broadcasts): `Minted` event correct, seed
      stamped, id 1 owned by the minter
- [ ] `withdraw(artist)` pulls the accrued split correctly
- [ ] OpenSea (and one other surface) shows the collection: name, image
      renders from the data URI, royalty displayed, contractURI metadata
      picked up
- [ ] ERC-4906 refresh honored after a cover/capture change

```
Prompt: You are a hands-on implementer; do this yourself. In the pnd
repo (~/foundation): run the launch collection's mainnet smoke test.
Collection <address>. Stage: (1) mintWithReferral(1, <PND referrer
address>, "") at the exact price; (2) withdraw(<artist>) after
confirming pendingWithdrawal via cast call; Dave broadcasts each, one
confirm per tx. Then verify offchain surfaces: decode tokenURI for
token 1 and confirm the image/metadata; load the collection on OpenSea
and confirm the grid image, royalty, and collection metadata appear
(use their metadata-refresh if stale); report every tx as an evm.now
link. If any read disagrees with expectations, stop and report — do
not improvise fixes on mainnet.
```

## Phase D — the mint surface

### D6. Launch mint page on pnd.ripe.wtf

- [ ] descriptor/config for the launch collection on the generic mint
      surface, live per-mint state via the cached-read helpers only
- [ ] PND's referrer address wired on the PND surface (`mintWithReferral`)
- [ ] `mintFor` gift flow exposed or consciously deferred
- [ ] tx links are evm.now; errors surface decoded revert reasons (walk
      the viem cause chain)

```
Prompt: You are a hands-on implementer; do this yourself. In the pnd
repo (~/foundation): add the launch collection's mint page to the
apps/web mint surface. Follow the existing generic mint surface
pattern (see apps/web/src/lib/ descriptor usage and the existing
/mint/[contract] route); collection <address>, sequential form, ABI
from @pin/abi. Mint calls mintWithReferral with PND's referrer address
<paste> on this surface. Live reads (price, status, minted) go through
the existing cached-read helpers — audit that the page adds zero
per-render RPC. Error handling must walk the viem error cause chain to
show decoded revert reasons. Exercise the full flow on local dev
against a fork before calling it done, and link the local URL tested.
```

### Homage mainnet env flip

Homage to the Punk ships as its own bespoke launch (see
`docs/pnd-surface-system.md` §8), and it needs one flip beyond the
generic D6 mint page: three Netlify env vars plus one code edit.

- [ ] `NEXT_PUBLIC_HOMAGE_COLLECTION_ADDRESS` set (the deployed Homage
      collection; read in `apps/web/next.config.ts:47`,
      `apps/web/src/lib/curated-chrome.ts:43`,
      `apps/web/src/app/collections/homage/page.tsx:24`,
      `apps/web/src/lib/mint-modules/homage.ts:140`)
- [ ] `NEXT_PUBLIC_HOMAGE_MINTER_ADDRESS` set (the `HomageMinter`
      extension address; `curated-chrome.ts:40`, `mint-modules/homage.ts:139`)
- [ ] `NEXT_PUBLIC_HOMAGE_RENDERER` set (`mint-modules/homage.ts:141`)
- [ ] `apps/web/src/lib/homage/registry.ts` `MAINNET_HOMAGE` const
      (line 29) edited from `null` to the deployed
      `{collection, minter}` pair and committed. This is separate from
      the three env vars above: `homageMinterFor()` in that file reads
      `MAINNET_HOMAGE` only on mainnet (the fork-mode branch reads env
      instead, see below), and it backs `detectHomageMinter()`
      (`apps/web/src/lib/homage/detect.server.ts`), which
      `apps/web/src/app/collections/[address]/page.tsx` (and its
      `redeem`/`[tokenId]` siblings) call to decide whether a
      collection address is the registered Homage collection and
      should render the bespoke Homage UI instead of the generic
      collection page. Env vars alone do not light this up; leaving
      `MAINNET_HOMAGE` at `null` leaves that detection dark on
      mainnet even with all three env vars set.

Note: `NEXT_PUBLIC_HOMAGE_COLLECTION` / `NEXT_PUBLIC_HOMAGE_MINTER`
(no `_ADDRESS` suffix) are a separate, fork-mode-only pair written by
`scripts/dev-collections.sh` and gated on
`NEXT_PUBLIC_USE_LOCAL_RPC === "1"` (`registry.ts` `forkHomage()`).
They are not read on mainnet and do not need to be set in Netlify.

None of the above vars are currently in any `.env.example`; the three
`_ADDRESS`/`_RENDERER` vars are documented (empty) in
`apps/web/.env.example`.

### D7. Artist-site embed (if the launch mints from the artist's own site)

- [ ] the sovereign artist-site template mints the launch collection
      with the ARTIST's address as referrer (they keep the share)
- [ ] template repo sync (`ripe0x/sovereign-artist-site`) picks it up

```
Prompt: You are a hands-on implementer; do this yourself. In the pnd
repo (~/foundation): wire the launch collection mint into
templates/artist-page/ so the artist's own site can mint it with the
artist's address as referrer (they keep the referral share on their
venue). Reuse the parity render + mint components; do not fork new
implementations. Remember templates/artist-page/ auto-syncs to
ripe0x/sovereign-artist-site on merge to main, so keep the template
self-contained. Exercise the template's dev preview end to end before
calling it done.
```

## Phase E — before announcing

### E8. RPC + health audit

- [ ] every new page answers: what RPC does it fire, from where, how
      often, is it cached?
- [ ] indexer deploy healthy on Railway; new tables populated; no
      crash-loop
- [ ] no fan-out regressions (list pages are SELECTs; detail pages are
      cached reads)

```
Prompt: You are a hands-on implementer; do this yourself. In the pnd
repo (~/foundation): audit every code path added for the collection
launch (discovery pages, studio list, mint page, artist embed) for RPC
leaks. For each new page/component, answer concretely: which RPC calls
fire, triggered from where, how often, cached how. Flag any read in a
component body, any polling tighter than its data actually changes,
any per-item loop that should be one SELECT or one multicall. Check
the Railway indexer service is healthy and the collections table is
populated. Produce a short findings list; fix the clear leaks, flag
anything ambiguous rather than guessing.
```

### E9. Docs + banner sweep

- [ ] status banners updated (system doc, reaudit notes, this runbook):
      "pre-deploy" → live, with addresses
- [ ] /docs reference shows deployed addresses (from A1); llms.txt +
      protocol-manifest regenerated
- [ ] reaudit notes get a closing entry: audited commit, auditor,
      deploy tx (evm.now link), deployed addresses

```
Prompt: You are a hands-on implementer; do this yourself. In the pnd
repo (~/foundation): the Surface system is live on mainnet. Sweep
the collection docs for stale pre-deploy status language:
docs/pnd-surface-system.md banner, docs/pnd-surface-reaudit-notes.md
(add a closing entry with the audited commit, reviewer, deploy tx as an
evm.now link, and deployed addresses), docs/pnd-surface-prelaunch.md
(check off what is done), AGENTS.md's Surface section. Regenerate
the reference docs and confirm zero stale terms. Do not touch
historical sections that are explicitly marked historical.
```

## Trailing (launch can precede these; artists-at-large cannot)

### T10. Verify the studio create wizard end-to-end

The wizard shipped unverified; the launch used scripts. Before opening
studio deploys to other artists, prove the wizard produces a correct,
fully-wired collection.

```
Prompt: You are a hands-on implementer; do this yourself. In the pnd
repo (~/foundation): verify the studio collection create wizard
end-to-end against local dev (scripts/dev-collections.sh + a local
anvil fork). Walk the real UI: create a collection through every step,
then verify onchain state matches every wizard input (config fields,
locks, creators, minters), the two-step publish flow works, and the
collection appears in the studio list and mint page. File concrete
bugs for anything that diverges; fix what is small and clearly wrong;
do not redesign the wizard.
```

### T11. Announcement material

- [ ] collection docs pages linkable (pnd.ripe.wtf/docs)
- [ ] launch mint URL, artist-site URL, and the "why sovereign" story
      (pnd-surface-system.md §6) in whatever the announcement is —
      no "Foundation" in marketing copy, "onchain" one word, "ETH" not Ξ,
      no em dashes in site copy
