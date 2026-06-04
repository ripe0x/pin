# PND Editions: mint-funded media permanence

> **Status: design doc, nothing built.** This is the "what should we build
> and why" for a single capability: letting **each edition mint contribute
> a slice toward keeping that edition's media alive over time**, without
> breaking any of PND's hard constraints.
>
> **Base / branch.** This design references the editions-on-MURI work in
> PR [#106](https://github.com/ripe0x/pin/pull/106) (`editions-on-muri-clean`):
> the sovereign storage substrate, the `PNDEditionsMuriOperator` +
> `PNDMuriRenderer` anchor flow, the Standard/Permanent create tier, the
> honest-status preservation badge, and the 0xSplits collaborator-split
> machinery. **#106 is still OPEN as of this writing.** Per the repo's
> squash-merge workflow, **implementation must branch off `main` AFTER #106
> is merged** — do not pile commits on the #106 branch. This doc can be
> reviewed now; code waits.
>
> Read first, in this order:
> - `docs/pnd-editions-media-pinning.md` — the pinning architecture this
>   builds on, **especially §4 "Rejected on fit: x402-paid pinning" and §5
>   "What an x402 integration would actually require."** This doc's whole
>   first job is to explain why the mechanic below is *not* the thing those
>   sections rejected.
> - `docs/pnd-editions-README.md`, `docs/pnd-editions-spec.md` — feature +
>   contract surface.
> - `docs/muri-integration.md` — the MURI overlay this composes with.

---

## 0. The one-sentence thesis

A mainnet-only, artist-sovereign edition protocol can let **a fixed slice
of every mint accrue into an artist-owned vault**, and let that vault fund
**two honest, swappable storage rails** — a pay-once durable floor
(Irys/Arweave) and a renewable hot pin (third-party Pinata via x402) —
**without PND ever custodying funds or media, running any paid endpoint, or
claiming a permanence it cannot back.** The contribution mechanic is the
real enabler and it is storage-backend-agnostic; the rails are pluggable
adapters that register their output URIs as MURI fallbacks so everything
composes with the anchor + renderer + honest-status badge already shipped
in #106.

The load-bearing principle, unchanged from the pinning doc: **PND does not
pin and does not hold money. The artist does.** This design adds a funding
primitive on top of that principle; it does not weaken it.

---

## 1. Motivation, and how this overcomes the prior x402 rejection

### 1.1 The gap

#106 gives an edition a way to anchor its shared artwork in MURI (fallback
URI set + SHA-256 hash + an onchain viewer that shows the first surviving
copy) and an honest badge that tells the truth about retrievability. What
it does **not** give is any *funding* for keeping those copies alive:

- The MURI anchor is only as durable as the URIs it points at. Today those
  are gateway URLs derived from the artist's own pin
  (`deriveFallbackUris` in `MuriAnchorPanel.tsx`). If the artist's pin
  lapses, every fallback rots together and the SHA-256 hash just proves the
  bytes are *gone*, honestly.
- The only "permanent" state the protocol can assert is
  `isPermanent() == sealed && metadataFrozen` (`PNDEditions.sol`) — which
  is about the *contract and renderer* being immutable, **not** about the
  *media bytes* being durable. A sealed, frozen edition can still point at a
  dead CID. That is a real honesty gap the badge surfaces but cannot fix.

So: the artwork's longevity rests entirely on the artist continuing to pay
for a pin, forever, out of band. That is exactly the failure mode the
honest-status ethos is built to expose — but exposing it is not the same as
giving the artist a tool to *fund* against it.

### 1.2 What this adds

A way for the economic activity that *creates* the demand for permanence —
minting — to also *fund* it. A small, fixed `permanenceBps` slice of each
mint accrues to an artist-owned vault; the vault pays storage rails; the
rails' output URIs become MURI fallbacks. The cash-flow shape (a trickle
per mint) matches the cost shape of renewable pinning (a recurring rent),
and a pay-once Arweave floor gives a durable backstop the recurring rail
cannot.

### 1.3 Why this is not the x402 integration that was rejected

The pinning doc rejected x402 for two stacked reasons (§4, §5). **This
design defeats both, because it changes who runs what.**

**Rejection reason A — "PND would have to run a paid pinning endpoint, hold
a provider key server-side, and eat the upstream storage cost" (§5.1).**
That was the custody trap: to *sell* pinning, PND becomes the storage
provider, holds the key, carries the liability. **This design has PND sell
nothing and run nothing.** The x402 endpoint is **Pinata's** public
pay-to-pin service (`pinata.cloud/blog/pay-to-pin-on-ipfs-with-x402`). PND
operates no endpoint, holds no provider key, signs no facilitator, and
prices nothing. PND's only role is UI: showing the artist their vault
balance, their funded-through date, and a "renew" affordance. The bytes go
artist-account-to-Pinata; the money goes vault-to-Pinata. **PND is never in
the media path or the money path.** That is the precise objection §5
raised, and it is structurally absent here.

**Rejection reason B — "x402's canonical settlement is USDC on Base, which
imports an L2 + stablecoin into a mainnet-only ETH protocol" (§5, the
mainnet-vs-Base tension).** Still true, but **contained to one rail and one
actor.** The mint stays 100% mainnet ETH. The Arweave floor is paid in
**mainnet ETH** (Irys accepts it). Only the *recurring hot-pin rail* needs
USDC-on-Base, and that crossing happens **off the mint path entirely**: a
keeper batches accrued ETH and crosses it to a bounded Base USDC float on
its own cadence (§4). The artist minting an edition never touches Base or
USDC. The L2/stablecoin coupling is demoted from "every artist, every
release" (which §5 correctly called the most off-ethos dependency in the
system) to "one keeper, periodically, for one optional rail."

**The third thing §5 flagged — "the gasless EIP-3009 mechanic is USDC-only;
ETH cannot `transferWithAuthorization`, so mainnet-ETH x402 needs a payment
channel, not a middleware drop-in."** This design **agrees and routes
around it** rather than fighting it. We do not try to bend x402 onto
mainnet ETH. The floor rail uses Irys's native mainnet-ETH funding (no
x402, no EIP-3009). The hot rail uses x402 *as designed* — native USDC on
Base, EIP-3009-signed — but by a keeper EOA, which is exactly the actor
EIP-3009 expects. We meet x402 where it is strong instead of dragging it
onto a chain where §5 showed it is uneconomic.

**Net:** the original rejection was "PND becomes a custodial paid storage
seller, and the only honest settlement breaks mainnet-only." This design
makes PND a non-custodial *facilitator of the artist's own funding of a
third party*, keeps the mint and the floor on mainnet ETH, and quarantines
the Base/USDC surface to a bounded keeper. The rejection stands for the
thing it rejected; this is a different thing.

> **Honest flag up front (revisited in §6 and §8):** the recurring rail
> buys *rented availability*, not permanence. Calling it "permanent" would
> re-introduce a different dishonesty than the one §4/§5 guarded against.
> The UI labels the floor "permanent (pay-once Arweave copy)" and the hot
> rail "pinned, funded through `<date>`," never collapsing the two.

---

## 2. Contribution mechanic — `permanenceBps` + artist-owned vault

### 2.1 The primitive already exists

`PNDEditions._settle` (PR #106, `PNDEditions.sol:187`) is a pull-payment
splitter. Every mint accrues `msg.value` into `_pending[...]` balances and
tracks a running `_totalPending` (load-bearing for the
settle-before-upgrade invariant in `_authorizeUpgrade`). Today it has two
legs:

```
total ──► surfaceCut (SURFACE_SHARE_BPS, only if surface != 0)
     └──► artistCut  (remainder → payoutAddress, or owner() if unset)
```

And the artist's `payoutAddress` can already be a **0xSplits split**: the
create form (`CreateEditionForm.tsx:202`) optionally deploys an immutable
split (`createSplit(accounts, allocations, 0, address(0))`,
`buildSplitArgs` in `pnd-editions.ts:288`) and sets it as `payoutAddress`,
so the artist's cut fans out to collaborators with zero protocol change.
**The permanence slice rides this same splitter primitive.** That is the
whole reason it is the real enabler and is backend-agnostic: it is just one
more payee leg, and what that payee *does* with the ETH is the rails'
problem (§3).

### 2.2 Two ways to slot it — and the one to ship

**Option A — vault as a 0xSplits recipient (zero core-contract change).**
Add the permanence vault as one row in the artist's payout split, e.g.
`{vault: 1%, artist: 99%}`, or `{vault: 1%, artistA: 59%, artistB: 40%}`.
The slice is carved out of the artist+collaborator 100% pool by the split.

- **Pro:** *no change to the audited core contract.* Reuses `createSplit`
  verbatim. Shippable the day after #106 merges.
- **Con:** it conflates "fund permanence" with "pay a person." The vault
  competes with collaborators for the same 100%, so adding permanence
  silently dilutes every collaborator, and the UI can only describe it as
  "a collaborator that happens to be a vault." Splits are also immutable
  once deployed — changing the permanence slice later means deploying a new
  split and `setPayoutAddress`. It works, but it muddles the semantics.

**Option B — a first-class `permanenceBps` leg in `_settle` (recommended
end-state).** Mirror `SURFACE_SHARE_BPS`: take the permanence slice as its
own leg, *before* the artist/collaborator split, routed to a per-edition
`permanenceVault`.

```
total ──► surfaceCut    (SURFACE_SHARE_BPS, only if surface != 0)
     ──► permanenceCut  (permanenceBps of the post-surface remainder → permanenceVault)
     └──► artistCut     (remainder → payoutAddress, may itself be a collaborator split)
```

- **Pro:** permanence is a distinct protocol concept with its own honest
  line ("X% of every mint funds keeping this alive"), it *composes with*
  collaborator splits instead of competing inside them, and it is
  adjustable for future mints via a setter without redeploying a split.
  Collectors still pay exactly `price * quantity` (honest pricing intact —
  the slice comes out of the artist's proceeds, not added on top).
- **Con:** it touches the core contract that #106 ships and audits:
  `EditionConfig`, `_settle`, the `__gap`, and a new setter. That is real
  audit surface (§6), and it cannot land until #106 is merged and
  re-audited.

**Recommendation (best long-term):** Option B is the structurally correct
design and the end-state. Permanence funding deserves to be a first-class
leg, not a fake collaborator. **But the phased rollout (§7) ships Option A
first** — not as a "simpler shortcut," but because Option A delivers the
entire *value* (mints accrue toward a vault, rails spend it, URIs become
MURI fallbacks) with zero core-contract risk, and it lets the rails,
keeper, and honest-status work be built and proven against a real vault
*before* anyone reopens the audited splitter. Option A is the bootstrap;
Option B is the graduation, gated on a deliberate decision to re-audit the
core. The doc is explicit that Option A's semantics are a compromise and B
is where it lands.

### 2.3 The contract changes for Option B (when we take it)

All additive and append-only, respecting the upgrade-safety note above the
`__gap` in `PNDEditions.sol:90`:

- **`EditionConfig`** (`PNDEditionsTypes.sol:84`) gains two fields:
  `uint16 permanenceBps` and `address permanenceVault`. Append at the end
  of the struct (calldata-compatible; the create flow already builds this
  struct in `CreateEditionForm.buildCfg`).
- **`_settle`** gains a third leg, taken from the post-surface remainder so
  the surface share math is unchanged:
  ```solidity
  uint256 afterSurface = total - surfaceCut;
  uint256 permCut = _cfg.permanenceVault == address(0)
      ? 0
      : (afterSurface * _cfg.permanenceBps) / BPS;
  if (permCut > 0) { _pending[_cfg.permanenceVault] += permCut; emit PermanenceFunded(...); }
  uint256 artistCut = afterSurface - permCut;
  ```
  `_totalPending` accounting is unchanged (one `+= total` still covers all
  legs, since `surfaceCut + permCut + artistCut == total`). `withdraw(vault)`
  is permissionless exactly like every other payee, so anyone can flush the
  vault's accrual, and the settle-before-upgrade invariant still holds.
- **A cap + a setter:** `MAX_PERMANENCE_BPS` (sane ceiling, e.g. 20%, so a
  permissionless deployer can't grief an artist with a 99% permanence
  slice), and `setPermanenceBps` / `setPermanenceVault` (owner-only, future
  mints only, mirroring `setPayoutAddress` semantics at
  `PNDEditions.sol:277`).
- **No change** to mint, Mint Mark, graph, path, seal, or freeze logic.

### 2.4 The vault contract — `PNDPermanenceVault`

Artist-owned, PND-ownerless, holds the accrued ETH, and is the thing the
rails spend from. Design goals: **sovereign (artist owns it), bounded
(a keeper can never drain it), auditable (every spend emits an event the
worker indexes), and rail-agnostic (it understands "release funds toward an
allowlisted destination," not "Irys" or "Pinata").**

Sketch of the surface:

```solidity
contract PNDPermanenceVault is Ownable2Step {       // owner = artist
    // Allowlisted spend destinations, set by the artist. Prevents a
    // compromised/over-eager keeper from sending anywhere arbitrary.
    mapping(address => bool) public allowedDestination;   // Irys deposit, keeper float
    // Bounded keeper authority: an EOA that may move funds ONLY to
    // allowlisted destinations, ONLY up to a rolling per-period cap.
    address public keeper;
    uint256 public keeperPeriodCap;       // e.g. max wei per epoch
    uint256 public keeperEpochLength;     // e.g. 30 days
    // ... rolling-window accounting of keeper spend ...

    receive() external payable {}         // accrues from withdraw(vault) + direct sends

    // Artist: full authority, any destination.
    function ownerSpend(address to, uint256 amount, bytes calldata memo) external onlyOwner;
    // Keeper: allowlisted destinations only, within the rolling cap.
    function keeperSpend(address to, uint256 amount, bytes calldata memo) external onlyKeeper;

    function setKeeper(address, uint256 cap, uint256 epoch) external onlyOwner;
    function setAllowedDestination(address, bool) external onlyOwner;
    // Escape hatch: artist can always pull everything back out.
    function sweep(address to) external onlyOwner;
    event Spent(address indexed to, uint256 amount, bytes memo);
}
```

Key properties:

- **PND custodies nothing.** The vault is `Ownable2Step` by the artist. PND
  is never owner, keeper, or destination.
- **Keeper trust is bounded by construction**, not by promise: the keeper
  can spend only to artist-allowlisted destinations and only up to a rolling
  cap. Compromise of the keeper key caps the loss at one epoch's float, sent
  only to addresses the artist pre-approved.
- **The `memo` field** carries the rail + target (e.g. the CID being
  renewed, the Irys upload id) so the worker can index every spend and tie
  it back to a fallback URI and a funded-through date (§5).
- **Bootstrap (Option A) needs no vault contract at all:** the "vault" can
  be the artist's own EOA as the split recipient, and the artist self-spends
  via the rail UI. The `PNDPermanenceVault` contract is the upgrade that
  unlocks the bounded *keeper* model and graduates alongside Option B. The
  doc keeps them decoupled so the funding mechanic can ship before the
  automation does.

---

## 3. The pluggable spend-rail interface

The vault holds ETH; rails turn ETH into durable/available copies and emit
the resulting URI. Rails must be **swappable** so backends are not
hard-wired — Irys today, Filecoin/Storacha tomorrow, without touching the
vault or the contract.

### 3.1 The interface (off-chain orchestration, minimal on-chain footprint)

A rail is mostly an **off-chain adapter** (in `apps/web` for artist-driven
spends, in `apps/worker` for keeper-driven renewals) plus the vault's
generic "release funds to an allowlisted destination." The vault
deliberately does **not** import rail-specific logic — that keeps rails
addable without a contract change.

```ts
// apps/web/src/lib/editions/permanence/rails/types.ts
export type RailKind = "irys-arweave" | "pinata-x402" | "storacha-filecoin"

export interface SpendRail {
  kind: RailKind
  /** Honest persistence character of what this rail produces. */
  durability: "permanent-floor" | "rented-hot"
  /** Quote the cost to store `bytes` for `termMonths` (Infinity = pay-once). */
  quote(bytes: number, termMonths: number): Promise<RailQuote>
  /**
   * Execute a funding step. Returns the URI(s) to register as MURI
   * fallbacks plus a funded-through date (null = pay-once/permanent).
   * Implementations call the vault's ownerSpend/keeperSpend to release ETH
   * (or, for the hot rail, draw from the keeper's Base USDC float).
   */
  fund(input: RailFundInput): Promise<RailFundResult>
}

export interface RailFundResult {
  uris: string[]              // ar://… or ipfs://… to addArtworkUris
  fundedThrough: number | null // unix seconds; null = pay-once
  spendTxs: `0x${string}`[]   // for the audit trail / honest-status badge
}
```

The two seams every rail shares: it (a) produces **URIs that go into MURI
via `addArtworkUris`** (`IMURIProtocol.sol:85`) under the canonical token id
0 used by `PNDEditionsMuriOperator`, so they compose with the existing
anchor + `PNDMuriRenderer` + decay monitor, and (b) reports a **durability
label and funded-through date** for the honest-status badge (§5).

### 3.2 Rail 1 — Permanent floor: Irys / Arweave (one-time, mainnet ETH)

The durable backstop. Pay once for a copy that persists without renewal.
**Irys accepts mainnet ETH directly**, so this rail needs **no bridge, no
Base, no USDC** — it stays entirely on the chain the mint already lives on.

Flow:
1. Artist (or keeper) funds an Irys balance from the vault in **mainnet
   ETH** (`ownerSpend`/`keeperSpend` → Irys's mainnet deposit destination,
   which is on the artist's allowlist).
2. The artist's own Irys account uploads the bytes (sovereign — the upload
   credential is the artist's, never PND's, same principle as the pinning
   doc's BYO-key model). Returns an Irys/Arweave id.
3. Register `ar://<id>` (and an `https://arweave.net/<id>` mirror) as a MURI
   fallback via `addArtworkUris`. The decay monitor already understands
   Arweave ids (`extractArweaveId` in `editions-persistence-status.ts:1`,
   and the probe's Arweave gateways).

- **Honest label:** "permanent (pay-once Arweave copy)." This is the only
  rail allowed to use the word *permanent*, and only once the copy is
  registered as a MURI fallback **and** its SHA-256 matches the anchor hash.
- **Alternative under the same rail slot:** a Storacha/Filecoin storage
  deal (pay-once-ish, deal-term-bounded). Slotted as a `storacha-filecoin`
  rail behind the same interface so the floor backend is swappable.

> **OPEN — must verify before relying on this (see §7 Phase 0):** that
> Irys mainnet-ETH funding works end-to-end *today* (fund balance in
> mainnet ETH → upload → retrievable `ar://` id → permanence settled on
> Arweave). Repo notes flag this as unconfirmed. If Irys mainnet-ETH
> funding is degraded, the floor rail falls back to the Storacha/Filecoin
> alternative, and the "no bridge needed for the floor" claim must be
> re-checked.

### 3.3 Rail 2 — Recurring hot redundancy: Pinata via x402 (rented, USDC on Base)

Renewable IPFS pinning through **Pinata's third-party pay-to-pin x402
endpoint**. PND runs nothing here — this is the move that dissolves the §4
custody objection (§1.3). Pricing is roughly $0.10/GB/month; a 12-month
term is ~$1.20/GB, renewable.

Flow:
1. The keeper holds a **bounded native-USDC float on Base** (§4).
2. When the decay monitor says a CID is approaching its funded-through date,
   the keeper calls Pinata's x402 endpoint, receives the `402` with payment
   requirements (native USDC on Base, EIP-3009), signs the
   `transferWithAuthorization` payload with its **EOA** key, and Pinata
   pins the CID for the paid term.
3. Register/refresh the `ipfs://<cid>` fallback in MURI (it is likely
   already a fallback from the artist's own pin; the renewal extends its
   funded-through date rather than adding a new URI).

- **Honest label:** "pinned, funded through `<date>`." **Never "permanent."**
  This is rented availability; when funds lapse, the pin lapses, and the
  badge says so.
- **The cost shape matches the cash-flow shape:** a recurring rent funded by
  a recurring per-mint trickle. That symmetry is the reason this rail exists
  alongside the floor rather than instead of it.
- **Alternative under the same slot:** Lighthouse (also perpetual/renewable
  IPFS+Filecoin pinning) behind the same `SpendRail` interface.

### 3.4 Why two rails, not one

The floor and the hot layer answer different questions and the honest-status
ethos demands both be labeled distinctly:

| | Permanent floor (Irys/Arweave) | Hot redundancy (Pinata x402) |
|---|---|---|
| Payment | one-time | recurring |
| Asset/chain | **mainnet ETH** | native USDC on **Base** |
| Crossing needed | none | yes (keeper, §4) |
| Durability | pay-once, ~permanent | rented, lapses without renewal |
| Honest label | "permanent" | "funded through `<date>`" |
| Retrieval speed | slower (Arweave gateways) | fast (IPFS gateways, hot) |

The floor is the thing you can almost honestly call permanent; the hot
layer is the thing that is *fast and redundant right now*. An edition can
have both, and the badge shows both truthfully. Both register as MURI
fallbacks, so `PNDMuriRenderer` (`PNDMuriRenderer.sol:84` `_media`) and
MURI's "first surviving copy" viewer pick whichever is alive at read time —
the design composes with #106 with zero renderer change.

---

## 4. The keeper model and the mainnet-ETH → Base-USDC crossing

Only the **recurring hot rail** needs this. The floor stays mainnet ETH.

### 4.1 Why a keeper exists at all (the EIP-3009 / EOA reality)

x402 settles via EIP-3009 `transferWithAuthorization`, which is **signed by
an EOA**. A contract vault **cannot self-sign** an EIP-3009 authorization.
So *someone with an EOA key* must hold the USDC and sign the payment. This
is not a PND choice; it is how x402/EIP-3009 works. The design question is
only *whose* EOA, and how to bound the trust it carries.

### 4.2 Never cross per-mint — batch

Mainnet gas dwarfs a sub-dollar pin (§5 of the pinning doc made this point
and it stands). So the vault **accumulates** the per-mint ETH trickle, and
the crossing happens **periodically**, driven by the decay monitor's renewal
signal — never inline with a mint. The keeper draws down its Base USDC float
per renewal; it tops the float up by crossing a batch only when the float
runs low. The mint path touches none of this.

### 4.3 The crossing: ETH(mainnet) → native USDC(Base)

The vault holds ETH; Pinata wants native USDC on Base. The keeper bridges
in the fast deposit direction (mainnet → Base). Two routes:

- **Circle CCTP (preferred for native-asset correctness).** Burn USDC on
  mainnet, mint **native** USDC on Base — no slippage, no wrapped/bridged
  `USDC.e`, canonical asset on both sides. The catch: CCTP moves *USDC*, and
  the vault holds *ETH*, so the keeper must first swap mainnet ETH→USDC
  (a DEX step) then CCTP burn→mint. More steps, but every asset is canonical
  and there is no bridge-aggregator trust.
- **Across / LI.FI (one-shot, faster, more trust).** A bridge aggregator
  does ETH(mainnet)→USDC(Base) in a single intent. Fewer steps, fast
  settlement, but you trust the aggregator's routing/relayers and eat
  swap+bridge slippage, and you must pin the output to *native* USDC on
  Base (not a bridged variant) so the x402 payment matches Pinata's required
  asset.

**Recommendation:** prefer **CCTP** for correctness (native USDC end to
end is the whole point of x402's asset requirement), and offer the
aggregator path as a pragmatic fallback when the multi-step CCTP flow is not
worth it for a small float. Keep the route behind the `SpendRail` adapter so
it is swappable. **OPEN (§7):** native-USDC-via-CCTP vs accepting a bridged
variant — resolve against what Pinata's facilitator actually requires.

### 4.4 Whose EOA is the keeper — the ethos tradeoff

**Option 1 — the artist is the keeper (cleanest for the ethos, recommended
default).** The artist's own EOA holds the bounded Base USDC float and signs
the x402 payments; PND provides the UI and a "your pins need renewing"
nudge. Fully sovereign: PND never holds a key or a float; the artist funds
their own work's permanence with their own hand. The cost is friction — the
artist must hold USDC on Base and act on renewals (the very friction §5 of
the pinning doc warned about), softened to *periodic* (not per-mint) by
batching, and softened further by the vault auto-accruing the ETH so the
artist only has to cross+renew, not fund from scratch.

**Option 2 — a permissionless tipped keeper bot (bounds the float, adds an
actor).** A keeper bot watches the decay monitor, crosses batches, and
renews, taking a small tip for gas+effort. The vault's `keeperSpend` caps
its authority (allowlisted destinations, rolling per-epoch cap), so the
trust is bounded to one epoch's float to pre-approved addresses. This
removes the artist's ongoing effort at the cost of introducing a third
party that holds a (bounded) float. PND could run a reference keeper, but
**PND running the keeper re-creates a custody surface** (PND holds USDC and
a signing key on the artist's behalf) — so if a bot is used, it should be
permissionless and tip-incentivized, *not* PND-operated, to stay off the
custody trap.

**Recommendation:** ship **Option 1 (artist-as-keeper)** as the default and
only v1 keeper — it is the sovereign, zero-PND-custody answer, and it keeps
the bounded-float complexity out of v1. Treat **Option 2** as a later,
opt-in convenience (permissionless bot, never PND-run), justified only if
artist-renewal friction proves to be the thing that kills adoption. This
mirrors the pinning doc's stance: lower the friction, never lower the
responsibility, and never let PND become the safety net.

### 4.5 Float sizing

The keeper float should be the *smallest* amount that covers near-term
renewals — sized to one or two renewal epochs of the editions the keeper
serves, not a war chest. Smaller float = smaller blast radius if the keeper
key is compromised. The vault's `keeperPeriodCap` enforces this from the
contract side; the keeper's top-up logic enforces it from the operations
side. **OPEN (§7):** the exact cap formula (per-edition vs per-keeper, how
many epochs of buffer).

---

## 5. MURI-fallback + honest-status / decay-monitor integration

This is where the funding mechanic re-joins the #106 machinery. Both rails'
outputs are just **MURI fallback URIs**, so nothing about the renderer
changes — but the *status* layer must learn to distinguish "permanent floor
present" from "hot pin funded through a date," and the *probe* must become a
time series so the keeper knows when to renew.

### 5.1 Register every rail output as a MURI fallback

Both rails call `addArtworkUris(edition, CANONICAL_TOKEN_ID, uris)`
(`IMURIProtocol.sol:85`, canonical id 0 per `PNDEditionsMuriOperator`). The
Arweave floor adds `ar://…`; the hot rail keeps `ipfs://…` fresh. MURI's
"first surviving copy" viewer and `PNDMuriRenderer._media`
(`PNDMuriRenderer.sol:84`) already pick whichever is alive at read time, so
**permanence funding requires no renderer or operator change** — it feeds
the existing fallback array. `addArtworkUris` is gated to owner/admin or
collector by MURI permissions, so the artist (owner) or the keeper-as-artist
can write fallbacks without any new trust.

### 5.2 Extend the honest-status model

`editions-persistence-status.ts` currently maps a single probe result +
attestation to: `retrievable | unretrievable | artist-pinned | unprobed |
external | none`. Extend the *status surface* (not necessarily the same enum)
to also express the **funding/durability dimension**, which is orthogonal to
retrievability:

- **`permanent-floor`** — an Arweave (or Filecoin-deal) copy is registered as
  a MURI fallback **and** its SHA-256 matches the anchor hash. The only
  state allowed to say "permanent."
- **`hot-funded-through <date>`** — a Pinata pin is funded through a known
  future date (derived from the last x402 renewal term).
- **`hot-lapsed`** — a previously funded hot pin's funded-through date has
  passed and no permanent floor exists. The honest "this is rotting" state.

These compose with the existing retrievability statuses: an edition can be
`retrievable` *and* `permanent-floor`, or `retrievable` *and*
`hot-funded-through 2026-12` with no floor (fast now, durable never), or
`unretrievable` *and* `hot-lapsed` (the failure the badge must show
loudly). The badge must **never** show "permanent" off the back of a hot pin
alone — that is the over-promise this whole doc is guarding against.

### 5.3 Turn the one-shot probe into a decay monitor

The `cid_availability` probe (`db/migrations/018`, worker
`probe-cid-availability.ts`) is today a single most-recent-result cache
(gateway `HEAD`, 7-day cadence, known-artist gated). For renewals the keeper
needs a **time series**: when was each fallback last seen, what is its
funded-through date, and is it trending toward expiry?

- Store probe results as a **history**, not just the latest, keyed by CID +
  timestamp (extend `018` or a sibling `cid_availability_history` table).
- Compute, per edition fallback set, a **funded-through estimate** from the
  last recorded x402 renewal term (indexed from the vault's `Spent` event
  `memo`, §2.4) and a **decay signal** from the probe trend.
- Emit a **renewal signal** when funded-through is within a lead-time window
  (e.g. 30 days out) — this is what the keeper (artist or bot) acts on, and
  what drives the "your pins need renewing" nudge in the UI.

This stays RPC-light by construction (the same gateway `HEAD` probe the
pinning doc designed; the funding/renewal data comes from indexing the
vault's events, not from new chain reads), consistent with the
minimize-RPC rule.

### 5.4 The audit trail

Every vault `Spent` event (rail, amount, target CID/upload id, funded-through
in the `memo`) is indexed by the worker and tied to the edition's fallback
set, so the badge can show *what was funded, when, by which rail, through
what date* — the honest, verifiable provenance of the work's own
permanence. This is the funding analogue of the Mint Mark: provenance of
preservation, computed not asserted.

---

## 6. Security and custody analysis

The whole design is a custody-avoidance exercise. Enumerated:

1. **PND custodies no funds.** The vault is `Ownable2Step` by the artist;
   PND is never owner, keeper, or an allowlisted destination. The keeper
   float (if a bot is ever used) is held by the artist or a permissionless
   bot, never PND. The mint's `_settle` only ever accrues to
   `_pending[...]` and is withdrawn permissionlessly to the owed address —
   PND is not a payee.
2. **PND custodies no media.** Bytes go artist-account-to-provider (Irys
   upload with the artist's credential; Pinata pin of the artist's CID). PND
   holds no provider key and runs no endpoint. This is the §1.3 resolution
   of the original x402 custody objection.
3. **PND runs no paid endpoint.** The only x402 endpoint is Pinata's. PND
   operates no facilitator, no settlement signer, no priced route.
4. **Keeper compromise is bounded.** `keeperSpend` is restricted to
   artist-allowlisted destinations and a rolling per-epoch cap; a stolen
   keeper key loses at most one epoch's float to pre-approved addresses
   (§4.4). The artist can revoke the keeper and `sweep` at any time.
5. **The core-contract change (Option B) preserves every #106 invariant.**
   The permanence leg is additive and append-only above `__gap`; it does not
   touch mint, Mint Mark, graph, path, seal, or freeze; `_totalPending`
   accounting is unchanged (still one `+= total`), so settle-before-upgrade
   and the no-fund-sweep upgrade guard (`_authorizeUpgrade`,
   `PNDEditions.sol:397`) still hold; `MAX_PERMANENCE_BPS` caps a malicious
   permissionless deployer; setters are owner-only and future-mints-only.
   **This requires a fresh audit pass** — it reopens the audited splitter,
   which is precisely why §7 phases it after the rails are proven against
   Option A.
6. **No new RPC fan-out.** Rails are provider-API (HTTP) and bridge calls,
   not chain reads; the decay monitor is gateway `HEAD` + event indexing.
   The only new chain writes are artist/keeper-signed spends and
   `addArtworkUris` — all user-initiated, none on the public read path.
   (Consistent with the standing minimize-RPC rule.)
7. **Honest-status integrity.** The hard rule: the badge never asserts a
   durability the rail cannot back. "Permanent" requires a hash-verified
   Arweave/Filecoin floor copy registered as a MURI fallback; a hot pin is
   always "funded through `<date>`." A lapsed hot pin with no floor shows as
   rotting, not as fine.

**Rejected designs (the custody traps, restated so they are not
relitigated):**

- **PND wraps the storage provider** (runs the pinning endpoint, holds the
  provider key, prices above cost). This is the exact §4/§5 trap. Rejected
  — it is custody by another name and re-creates everything #106's pinning
  doc rejected.
- **PND runs the keeper** (holds USDC float + signing key for artists).
  Rejected — custodial reach over the artist's funds. If a bot is ever
  needed, it is permissionless and tip-incentivized, not PND-operated.
- **PND-owned vault / PND-owned Storacha space.** Rejected for the same
  reason the pinning doc rejected the convenient Storacha flavor where PND
  owns the space: if the funds or bytes live in PND's account, the artist
  has not taken responsibility, which is the whole point.

---

## 7. Open questions

1. **Verify Irys mainnet-ETH funding end-to-end.** The floor rail's "no
   bridge needed" claim rests on this and repo notes flag it unconfirmed.
   Phase 0 blocker: fund an Irys balance in mainnet ETH, upload, confirm a
   retrievable `ar://` id and Arweave settlement. If degraded, fall back to
   the Storacha/Filecoin floor and re-check the "floor stays mainnet" claim.
2. **Native vs bridged USDC on Base.** Does Pinata's x402 facilitator
   require *native* USDC (favoring CCTP) or accept a bridged variant
   (allowing a one-shot aggregator)? Resolves the §4.3 route choice.
3. **Keeper model for v1: artist-as-keeper only, or also a permissionless
   bot?** Recommendation is artist-only for v1 (§4.4); confirm before
   building any bot.
4. **Keeper float sizing / `keeperPeriodCap` formula.** Per-edition vs
   per-keeper; how many renewal epochs of buffer (§4.5).
5. **Economic sustainability — does a `permanenceBps` slice actually
   self-fund renewals?** *This is the load-bearing honesty question.* A 1%
   slice of a 100 × 0.01 ETH edition is ~0.01 ETH (~$30+), which funds many
   GB-years of Pinata and a comfortable Arweave floor. A 1% slice of a
   low-price, low-volume edition may not cover even one year of hot pinning.
   **The mechanic cannot guarantee perpetual renewal from a one-time
   trickle** — the recurring rail is best-effort "funded as far as the slice
   goes," and the *only* state approaching permanence is the pay-once Arweave
   floor (and even that is a single copy). **Flag:** the UI must not imply
   indefinite renewal; it must show the funded-through date and let it lapse
   honestly. Recommendation: bias the default toward spending the slice on
   the **floor first** (durable, pay-once) and treat the hot rail as the
   overflow, so a small slice still buys real durability rather than a hot
   pin that lapses in a year.
6. **Option B core-contract change: when to reopen the audited splitter?**
   Gate Option B on (a) #106 merged and (b) rails proven against Option A,
   then a dedicated audit pass for the new `_settle` leg.
7. **Per-edition vault vs shared factory-deployed vaults.** One vault per
   edition (clean ownership, more deploys) vs one artist vault shared across
   their editions (fewer deploys, shared float, muddier per-edition
   accounting). Lean per-edition for clean honest-status accounting; revisit
   if deploy cost bites.

---

## 8. Phased rollout

Each phase is independently shippable and verifiable. The ordering puts the
**backend-agnostic funding primitive first** (it is valuable on its own,
before any rail automation), keeps the audited core contract closed until
the rails are proven, and treats the Base/USDC keeper as the last and most
optional piece.

**Phase 0 — Verify the unconfirmed externals (blocker, no code).** Confirm
Irys mainnet-ETH funding → upload → retrievable `ar://` end to end (OQ1).
Confirm Pinata x402's required asset on Base (native vs bridged USDC, OQ2).
Until these are real, the rails are speculative; nail them first.

**Phase 1 — Contribution mechanic via the existing split (Option A, zero
core-contract change).** After #106 merges, branch off updated `main`. Let
the create flow add the vault as a payout-split recipient (artist EOA as the
"vault" to start), so a `permanenceBps`-equivalent slice of every mint
accrues toward it. UI: show the accruing balance on the edition page.
*Value delivered with no audited-contract risk: mints now fund a pot
earmarked for permanence.* Verify on the `pnpm dev:editions` fork: deploy an
edition with a permanence recipient, mint, assert the slice accrues and is
withdrawable.

**Phase 2 — Permanent floor rail (Irys/Arweave, mainnet ETH).** Build the
`SpendRail` interface and the `irys-arweave` adapter. Artist-driven spend
from the Phase 1 pot → Irys mainnet-ETH funding → upload → `ar://` id →
`addArtworkUris` under canonical id 0. *This is the highest-value rail: it
is the only one that approaches permanence, needs no bridge, and composes
directly with the #106 MURI anchor.* Verify: funded floor copy is a MURI
fallback, hash matches, badge shows `permanent-floor`.

**Phase 3 — Honest-status + decay monitor.** Extend
`editions-persistence-status.ts` with the durability dimension
(`permanent-floor` / `hot-funded-through` / `hot-lapsed`), turn the
`cid_availability` probe into a time series (history table), index the
vault/spend events for funded-through dates, and emit the renewal signal +
"your pins need renewing" nudge. *The honest mirror for the funding layer.*
Verify against seeded probe history that the badge tells the truth in each
state.

**Phase 4 — `PNDPermanenceVault` contract (bounded keeper substrate).**
Ship the artist-owned vault with allowlisted destinations + bounded keeper
authority, replacing the Phase 1 "EOA-as-vault." Its own Foundry tests
(ownership, keeper cap, sweep, settle-before-upgrade composition). Gated on
its own review. *Unlocks the keeper model without yet using Base.*

**Phase 5 — Recurring hot rail + the Base crossing (most optional).** Build
the `pinata-x402` adapter, the CCTP (and/or aggregator) crossing, and the
artist-as-keeper renewal flow drawing on a bounded Base USDC float driven by
the Phase 3 decay signal. *Last because it is the only piece that touches
Base/USDC, carries the most external dependency, and is rented (not
permanent) — strictly an availability enhancement on top of the floor.*
Verify on a Base testnet float: a decay signal triggers an x402 renewal, the
funded-through date advances, the badge updates.

**Phase 6 — First-class `permanenceBps` leg (Option B, core-contract
change).** Graduate from the split-recipient bootstrap to a real `_settle`
leg + `EditionConfig` fields + cap + setters (§2.3), with a dedicated audit
pass on the reopened splitter. Gated on Phases 1–3 proving the value and on
a deliberate decision to re-audit the core. *Structurally correct end-state;
deliberately last so it rides proven rails rather than blocking them.*

**Where the value lands early:** Phases 1–3 deliver the whole honest
story — mints fund a pot, the pot buys a durable Arweave floor, and the
badge tells the truth about it — with **no Base, no USDC, no keeper bot, and
no change to the audited core contract.** Phases 4–6 are the
automation/recurring/first-class-leg upgrades, each independently gated.

---

## 9. Alignment check (honest-status ethos)

- **Best long-term solution leads:** the recommended end-state is the
  first-class `permanenceBps` leg + dedicated vault + floor-first spend
  policy, not the minimal split hack. The split-recipient bootstrap is
  explicitly framed as a de-risking step that ships value before reopening
  the audited core, not as the destination.
- **No over-promise:** the floor is the only thing labeled "permanent," and
  only when hash-verified and registered; the hot rail is always "funded
  through `<date>`"; a one-time slice is never implied to fund renewals
  forever (OQ5). The single biggest honesty risk — selling rented pinning as
  permanence — is called out in §1, §3.4, §5.2, and §7.
- **PND holds nothing:** no funds, no media, no provider key, no paid
  endpoint, no keeper float. Every custody trap is enumerated and rejected
  in §6.
- **Composes, does not reinvent:** rides the #106 `_settle` splitter, the
  0xSplits flow, the MURI anchor/operator/renderer, the `cid_availability`
  probe, and the persistence-status model — extending each rather than
  building a parallel stack.
```
