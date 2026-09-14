# Surface v2: launch runbook

> **What this is.** The ordered checklist from a clean v2 checkout to a
> mainnet launch, mirroring `docs/pnd-surface-prelaunch.md`'s structure for
> v1. Each item carries a ready-to-paste kickoff prompt for a fresh Claude
> Code session in this repo. `docs/pnd-surface-v2-audit-2026-09-14.md`
> covers the internal audit; `docs/pnd-surface-audit-scope.md`'s v2 section
> lists what remains for an external auditor.
>
> **Standing rules that apply to every item below:** a mainnet transaction
> broadcasts only when Dave explicitly says so in the task; mainnet
> explorer links use `https://evm.now/address/<addr>?chainId=1` (or
> `/tx/<hash>?chainId=1`), sepolia links use
> `https://sepolia.etherscan.io/address/<addr>`; the deploy path is
> `contracts/script/DeploySurfaceV2.s.sol` through `contracts/script/
> deploy.sh <env>`, the same script and wrapper for anvil, the fork test,
> sepolia and mainnet, per `contracts/README.md`'s "Surface v2 deploy"
> section.

## Prerequisites

- [ ] keystore `ripe0x` imported (`cast wallet import ripe0x
      --interactive`), `DEPLOYER_ACCOUNT=ripe0x` exported
- [ ] `DEPLOYER_PASSWORD_FILE` set to a chmod 600 file holding the keystore
      password, so the wrapper skips the interactive prompt
- [ ] `ETHERSCAN_API_KEY` set in the shell env only, never written to an
      env file under `contracts/script/env/`
- [ ] `forge build` run once with the target profile before computing any
      time-sensitive parameter, since a cold `via_ir` compile can take
      minutes and a mint-window start computed before the build lands in
      the past

```
Prompt: You are a hands-on implementer; do this yourself. In the pnd repo
(~/foundation/contracts): prepare the Surface v2 deploy prerequisites.
Import the ripe0x keystore if it is not already present (cast wallet
import ripe0x --interactive), confirm cast wallet address --account ripe0x
resolves to 0xCB43078C32423F5348Cab5885911C3B5faE217F9, set
DEPLOYER_PASSWORD_FILE to a chmod 600 path, confirm ETHERSCAN_API_KEY is
set in the shell env, and run forge build once with FOUNDRY_PROFILE
matching script/env/sepolia.env's FOUNDRY_PROFILE value. Report the
resolved deployer address and confirm the build finished with no errors.
No transactions.
```

## Sepolia deploy

The wrapper runs the same guards, the same script, and the same record
format sepolia and mainnet share.

```bash
DRY_RUN=1 contracts/script/deploy.sh sepolia
```

```bash
contracts/script/deploy.sh sepolia
```

- [ ] `DRY_RUN=1` run completes clean: every guard passes, the simulation
      reports the expected contract set, nothing is written
- [ ] deployer's code checked for the `0xef0100` EIP-7702 prefix
      (`cast code <deployer> --rpc-url <sepolia rpc>`); `deploy.sh` always
      broadcasts with `--slow` regardless of the result, so a delegated
      signer never lands a gapped nonce across the multi-transaction deploy
- [ ] real broadcast run; every transaction confirmed before the next one
      sends
- [ ] if the broadcast stops partway from a dropped RPC connection,
      recover with `contracts/script/deploy.sh sepolia --resume` only
      after confirming the deployer's nonce has not moved since the
      failed run; if it has moved, start a fresh broadcast instead

```
Prompt: You are a hands-on implementer; do this yourself. In the pnd repo
(~/foundation/contracts): run the Surface v2 sepolia deploy. First
DRY_RUN=1 script/deploy.sh sepolia and confirm every guard passes and the
simulated contract set matches DeploySurfaceV2.s.sol's expected set (
SurfaceV2 implementation, FixedPriceMinterV2 implementation, RenderAssets,
DefaultRenderer if not already recorded, SurfaceFactoryV2). Then run
cast code <deployer> --rpc-url <sepolia rpc> and confirm the deployer's
code, reporting whether it carries the 0xef0100 EIP-7702 prefix. Then run
script/deploy.sh sepolia for the real broadcast. If it stops partway from
a dropped connection, check the deployer's nonce before deciding whether
--resume is safe. Paste the wrapper's own readback output at the end. No
mainnet transactions.
```

## Post-deploy readbacks

Confirm the factory's wiring on chain before trusting the record file.

```bash
cast call <factory> 'sequentialImplementation()(address)' --rpc-url <sepolia rpc>
```

```bash
cast call <factory> 'minterImplementation()(address)' --rpc-url <sepolia rpc>
```

```bash
cast call <factory> 'defaultRenderer()(address)' --rpc-url <sepolia rpc>
```

```bash
cast call <factory> 'catalog()(address)' --rpc-url <sepolia rpc>
```

```bash
cast call <factory> 'paused()(bool)' --rpc-url <sepolia rpc>
```

- [ ] `sequentialImplementation`, `minterImplementation` resolve to the
      addresses in `deployments.sepolia.json`
- [ ] `defaultRenderer` points at a deployed `RenderAssets`-backed
      renderer, or is the empty sentinel if the env file left it unset
- [ ] `catalog` matches the shared Catalog address on chain id 11155111
- [ ] `paused` reads `true`; the factory lands paused per
      `LAND_PAUSED=true`

`deploy.sh` prints this same readback automatically at the end of a real
broadcast; a manual re-run here confirms it matches.

```
Prompt: You are a hands-on implementer; do this yourself. In the pnd repo
(~/foundation/contracts): read back the just-deployed sepolia
SurfaceFactoryV2's wiring with cast call for sequentialImplementation,
minterImplementation, defaultRenderer, catalog and paused (rpc: sepolia).
Compare each against deployments.sepolia.json. Report any mismatch and do
not proceed to verification until they agree. No transactions.
```

## Explorer verification

Every immutable contract that artists and collectors are asked to trust
must be readable.

- [ ] `SurfaceV2` implementation verified
- [ ] `FixedPriceMinterV2` implementation verified
- [ ] `RenderAssets` verified
- [ ] `DefaultRenderer` verified (if deployed this round)
- [ ] `SurfaceFactoryV2` verified
- [ ] an EIP-1167 clone address resolves to its implementation's readable
      source on the explorer's proxy detection

```
Prompt: You are a hands-on implementer; do this yourself. In the pnd repo
(~/foundation/contracts): verify the five just-deployed Surface v2
contracts on sepolia.etherscan.io with forge verify-contract, reading
constructor args from contracts/broadcast/DeploySurfaceV2.s.sol/11155111/
run-latest.json and compiler settings from foundry.toml. Contracts and
addresses: <paste from deployments.sepolia.json>. Confirm each shows
verified source, and that a test clone (create one via createSurface if
none exists yet) resolves to the implementation's source through the
explorer's proxy detection. Read-only and verification API calls; no
state-changing transactions.
```

## Record propagation

- [ ] `deployments.sepolia.json` carries the new keys
      (`surfaceFactoryV2`, `sequentialImplementationV2`,
      `minterImplementationV2`, `defaultRenderer`, `renderAssets`,
      `catalog`, `deployer`, `deployedAt`, `factoryDeployBlock`,
      `txHashes`), written by `deploy.sh` itself
- [ ] `packages/addresses/src/index.ts` reads the new keys automatically
      through its existing sepolia loader; confirm with
      `pnpm --filter web typecheck`
- [ ] a web preview that needs the new factory ahead of the packages
      update sets `NEXT_PUBLIC_SURFACE_FACTORY_V2` as a local override

```
Prompt: You are a hands-on implementer; do this yourself. In the pnd repo
(~/foundation): confirm deployments.sepolia.json carries the v2 keys the
Surface v2 deploy just wrote (surfaceFactoryV2, sequentialImplementationV2,
minterImplementationV2, defaultRenderer, renderAssets, catalog, deployer,
deployedAt, factoryDeployBlock, txHashes) and that packages/addresses/src/
index.ts's sepolia loader exposes them automatically. Run pnpm
--filter web typecheck. If a web preview needs the new factory before a
packages release, set NEXT_PUBLIC_SURFACE_FACTORY_V2 in apps/web/.env.local
as a local override and confirm it takes effect. No transactions.
```

## Indexer

Surface v2 discovery indexing is a separate concern from this launch's
contract work. The indexer schema cutover runbook (the ponder_v4 cutover)
owns that work; this item points to it for the cutover details and only
confirms the v2 factory's readiness for the discovery subscription it
adds.

- [ ] v2 factory address and deploy block recorded for the next indexer
      subscription pass
- [ ] confirmed with whoever owns the schema cutover that v2 discovery
      rides the same subscription work as the existing cutover

## Web smoke checks

- [ ] studio create flow produces a v2 collection on sepolia through the
      studio UI, exercised by hand
- [ ] the collection's mint page loads and a test mint succeeds
- [ ] the collection page renders name, image and royalty correctly

```
Prompt: You are a hands-on implementer; do this yourself. In the pnd repo
(~/foundation): exercise the Surface v2 sepolia deploy through apps/web.
Point the studio create flow at the sepolia SurfaceFactoryV2 (via
NEXT_PUBLIC_SURFACE_FACTORY_V2 if packages/addresses is not yet updated),
create a collection through the real UI, mint one token from its mint
page, and load its collection page. Confirm tokenURI renders, the mint
succeeds, and the collection page shows name, image and royalty. Link the
local URLs you tested. No mainnet transactions.
```

## Unpause decision

- [ ] every item in Explorer verification and Web smoke checks is done
- [ ] Dave decides when to call `setPaused(false)` on the sepolia factory;
      this is a state-changing transaction and follows the same per-broadcast
      confirm protocol as any other

## Mainnet gate

- [ ] external audit closed at the deployed commit, or an explicit waiver
      recorded by Dave (v1 shipped once under a waiver; v2 defaults to
      requiring the audit unless Dave says otherwise)
- [ ] `contracts/script/env/mainnet.env`'s `DEPLOYER` and `CATALOG` filled
      in; the wrapper refuses to run, `DRY_RUN` included, until both are set
- [ ] every mainnet broadcast (`contracts/script/deploy.sh mainnet`, and
      any post-deploy `cast send`) gets one `AskUserQuestion` confirm per
      transaction, decoded arguments shown, preceded by a `cast call`
      pre-flight read, per the mainnet transaction execution protocol
- [ ] the mainnet deployer's `--slow` broadcast is confirmed by
      `deploy.sh` itself (always passed, regardless of delegation)

## Address placeholders

Fill each row after its deploy; cross-check against the broadcast files in
`contracts/broadcast/DeploySurfaceV2.s.sol/<chainId>/run-latest.json`
before writing anywhere else.

| Contract | Sepolia | Mainnet |
|---|---|---|
| `SurfaceFactoryV2` | | |
| `SurfaceV2` implementation | | |
| `FixedPriceMinterV2` implementation | | |
| `RenderAssets` | | |
| `DefaultRenderer` | | |
| `Catalog` (reused public good) | | |
| Deploy block | | |
| Deploy tx | | |
