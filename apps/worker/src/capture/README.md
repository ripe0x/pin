# Surface thumbnail capture tool

Batch tool that renders a Surface collection's live tokens headlessly,
uploads the frames to Irys/Arweave, and points the collection's
`RenderAssets` capture template at the result. See
`docs/pnd-surface-thumbnails.md` for the protocol-level design and
`contracts/src/surface/renderers/RenderAssets.sol` for the onchain side
(`setCaptureTemplate`, `templateMaxTokenIdOf`, `imageFor`).

## What it does

1. Reads `idMode()` and `config()` on `CAPTURE_COLLECTION` and rejects
   anything but Sequential id mode (this tool only makes sense for
   sequential ids, where token id order is mint order).
2. Renders each live token's opening frame in headless Chromium, twice, and
   requires byte-identical PNGs before accepting a capture.
3. Signs and uploads each PNG (plus a shared cover image, once) to Irys as
   individual data items.
4. Builds an `arweave/paths` manifest (spec version 0.1.0) listing every
   captured token's path, and uploads it as one more Irys item.
5. Computes the coverage bound: the highest token id N such that every id
   1..N has been captured. See "The coverage bound" below.
6. Verifies the manifest against the Irys gateway, then calls
   `RenderAssets.setCaptureTemplate(collection, "ar://<manifestId>/{id}.png",
   bound)`.
7. Reads back `templateOf`, `templateMaxTokenIdOf`, and `imageFor` at the
   bound and one past it, and prints all four.
8. Attempts `notifyMetadataUpdate(1, bound)` on the collection so
   marketplaces re-fetch. This call needs the collection's renderer, owner,
   or admin key; the capturer key normally isn't one of those, so a failure
   here is logged and non-fatal.

## The coverage bound, and why there's no manifest fallback

The manifest lists a path per captured token and nothing else: no
`fallback`, no `index`. Coverage is enforced onchain instead:
`RenderAssets.imageFor(collection, tokenId)` only resolves the template for
`tokenId <= templateMaxTokenIdOf(collection)`; anything above that falls
through to the collection cover. So the bound, not the manifest, is what
keeps an unlisted id from ever being requested through the template.

The bound is the largest N with every id 1..N present, computed fresh from
every token this tool has ever captured for the collection (not just this
run). If token 3 fails its determinism check and gets skipped, the bound
stops at 2 even if tokens 4 and 5 rendered fine and are in the manifest --
they simply aren't reachable through the template until token 3 is
captured and a new bound is written. The run logs this explicitly when it
happens.

## Env vars

Required for the default `run` subcommand:

- `CAPTURE_CHAIN` -- `sepolia` or `mainnet`. Which chain the collection and
  `RenderAssets` live on.
- `CAPTURE_RPC_URL` -- RPC endpoint for that chain.
- `CAPTURE_COLLECTION` -- the Surface collection address.
- `CAPTURE_RENDER_ASSETS` -- the `RenderAssets` singleton address.
- `CAPTURE_FRAME_BASE_URL` -- base URL serving `frame.html` for the work
  (a local dev server, or a deployed preview).
- `CAPTURE_COVER_PATH` -- local path to the shared cover PNG.
- `CAPTURE_IRYS_NETWORK` -- `devnet` or `mainnet`. See "Two storage
  networks" below.
- `CAPTURE_OUT_DIR` -- where PNGs, verification copies, and the manifest
  record are written. Defaults to `capture-out`.
- `CAPTURER_PK` -- signs Irys uploads and broadcasts
  `setCaptureTemplate`/`notifyMetadataUpdate`. Required outside
  `--dry-run`. Never commit a real value; keep it in your shell env or
  `.env`, never in a file that gets staged.

The `refresh` subcommand needs only `CAPTURE_CHAIN`, `CAPTURE_RPC_URL`,
`CAPTURE_COLLECTION`, `CAPTURE_RENDER_ASSETS`, `CAPTURER_PK`. The `fund`
subcommand needs only `CAPTURE_RPC_URL`, `CAPTURE_IRYS_NETWORK`,
`CAPTURER_PK`.

`CAPTURE_IRYS_NETWORK` is independent of `CAPTURE_CHAIN`: a sepolia
collection can use `CAPTURE_IRYS_NETWORK=mainnet` for real, permanent
Arweave storage, since Irys funding is its own account keyed by the
signer, not tied to which chain the collection is deployed on.

## Subcommands

```
pnpm --filter @pin/worker capture:thumbnails -- [run] [--dry-run] [--force] [--tokens 1-5]
pnpm --filter @pin/worker capture:thumbnails -- fund <amount-in-eth>
pnpm --filter @pin/worker capture:thumbnails -- refresh [--from a] [--to b]
```

- `run` (the default when no subcommand is given): does the full flow
  above. `--dry-run` renders and computes everything, including the
  manifest and bound, but signs with a throwaway in-memory key and touches
  no funds, no Irys upload, and no chain write. `--force` re-captures every
  token in scope even if already on record. `--tokens a-b` restricts which
  discovered tokens are considered.
- `fund` tops up the Irys balance for `CAPTURER_PK` from its onchain ETH,
  in the amount given (e.g. `fund 0.01`).
- `refresh` re-emits `notifyMetadataUpdate(from, to)` on the collection
  without touching captures or the template. Defaults to `1..` the
  collection's current onchain `templateMaxTokenIdOf`. Run this after
  captures are confirmed, from whichever of the collection's renderer,
  owner, or admin keys you control -- the capturer key isn't one of those
  by default.

## Two storage networks, one verification path

`CAPTURE_IRYS_NETWORK=devnet` is a free rehearsal network; `mainnet` is
real, permanent Arweave storage paid for in ETH via Irys. Both are
verified identically before the chain write: every gating check
(`apps/worker/src/capture/verify.ts`) runs against the Irys gateway
(`https://gateway.irys.xyz` for mainnet, `https://devnet.irys.xyz` for
devnet), which serves an uploaded item immediately regardless of network.
The gates are:

- every uploaded item's bytes hash to the locally rendered PNG;
- every manifest path from 1 to the bound resolves through
  `<gateway>/<manifestId>/<id>.png` to that token's bytes;
- `<gateway>/<manifestId>/<bound + 1>.png` returns HTTP 404, proving the
  id past the bound is genuinely unlisted.

After the chain write, on `mainnet` storage only, the tool makes one
non-gating informational check: a `HEAD` to
`https://arweave.net/<manifestId>/<bound>.png`, logging whether Arweave L1
already serves the manifest. Irys seeds a mainnet upload to Arweave on a
delay, so a "not yet" here is expected and not an error. This check is
skipped entirely on devnet, since devnet uploads are never seeded to
Arweave.

## Resume and retry

The manifest record at `CAPTURE_OUT_DIR/manifest.<chain>.json` is the
source of truth for what's already captured. It's saved after every
durable step (cover upload, each token's upload, the manifest upload, the
chain write), so a crash or a stopped run leaves a record a retry can pick
up from:

- Tokens already in the record are skipped on the next run (`--force`
  overrides this).
- The cover item id is reused once set.
- If a manifest was uploaded in a prior run but the chain write never
  landed (and that run wasn't `--dry-run`), a run with nothing new to
  capture resumes straight at manifest verification instead of
  re-rendering and re-uploading everything.
- A record with `template` set always names a template that is live
  onchain; the only exception is a `--dry-run` record, which has no
  `templateTxHash`.

## Real-run commands

Sepolia collection, mainnet Arweave storage:

```
CAPTURE_CHAIN=sepolia \
CAPTURE_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
CAPTURE_COLLECTION=0x... \
CAPTURE_RENDER_ASSETS=0x... \
CAPTURE_FRAME_BASE_URL=https://your-preview-host \
CAPTURE_COVER_PATH=./cover.png \
CAPTURE_IRYS_NETWORK=mainnet \
CAPTURER_PK=$CAPTURER_PK \
pnpm --filter @pin/worker capture:thumbnails -- run
```

Sepolia collection, devnet storage (rehearsal, no real Arweave spend):

```
CAPTURE_CHAIN=sepolia \
CAPTURE_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
CAPTURE_COLLECTION=0x... \
CAPTURE_RENDER_ASSETS=0x... \
CAPTURE_FRAME_BASE_URL=https://your-preview-host \
CAPTURE_COVER_PATH=./cover.png \
CAPTURE_IRYS_NETWORK=devnet \
CAPTURER_PK=$CAPTURER_PK \
pnpm --filter @pin/worker capture:thumbnails -- run
```

Refresh after captures are confirmed (run from the renderer, owner, or
admin key):

```
CAPTURE_CHAIN=sepolia \
CAPTURE_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
CAPTURE_COLLECTION=0x... \
CAPTURE_RENDER_ASSETS=0x... \
CAPTURER_PK=$CAPTURER_PK \
pnpm --filter @pin/worker capture:thumbnails -- refresh
```

## Next change

`setCaptureTemplate` and the Irys upload are both paid by `CAPTURER_PK`
directly. The planned next step is `paidBy`: billing uploads against an
artist's own approved Irys balance instead, so the capturer key never
needs to hold funds.
