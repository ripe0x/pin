/**
 * Launch descriptors: reviewed per-launch defaults for the seeded deploy
 * page (app/collections/deploy/[slug]). One entry per launch — see
 * docs/pnd-surface-second-launch.md "Deploy page" section. A descriptor
 * only supplies the form's starting values; every field stays editable in
 * the UI before signing, and owner is never sourced from here (it's always
 * the connected wallet, see SeededDeployWizard).
 *
 * layoutKind selects the live collection page's presentation once
 * deployed (see lib/collection-layout.ts): "edition" for a one-artwork or
 * batch-editions release, "default" for the standard collection page.
 * This is a data lookup, not a hardcoded per-address component branch —
 * see AGENTS.md's note on the Homage anti-pattern.
 */

export type LayoutKind = "default" | "edition"

export type LaunchDescriptor = {
  /** URL slug: /collections/deploy/[slug]. */
  slug: string
  name: string
  symbol: string
  /** "" = open supply (no cap). */
  supplyCap: string
  royaltyBps: number
  /** "" = royaltyReceiver defaults to owner() onchain (SurfaceTypes.sol). */
  royaltyReceiver: string
  /** ETH string, e.g. "0.02". "" = gas-only mint. */
  price: string
  /** datetime-local strings. Both empty = no mint window (open now). */
  mintStart: string
  mintEnd: string
  /** Informational only today: FixedPriceMinter's walletCap is a
   *  post-deploy owner action (setWalletCap) via the studio mint-gate
   *  tool, not part of createSurface's SaleConfig as this wizard fills it
   *  (see DeployStep.buildSale — maxMints/walletCap are hardcoded to 0 at
   *  create, matching every other wizard preset). Kept here so the
   *  descriptor documents launch intent even though the deploy page
   *  doesn't wire it into the create tx. */
  walletCap: string
  /** "" = payoutRecipient defaults to the collection owner. */
  payoutRecipient: string
  /** The artist's deployed IBatchRenderRouter (or any IRenderer) address. */
  renderer: string
  creators: string[]
  layoutKind: LayoutKind
  /** Filled in after the artist's createSurface tx lands (see DeployStep's
   *  SuccessScreen). Drives getLayoutKindForCollection below — the live
   *  collection page's ONLY per-launch data point, so a launch never grows
   *  a bespoke component branch the way Homage did. */
  deployedAddress?: string
}

/**
 * "escape (blue)" — the second Surface launch (batch editions), working
 * title. Mostly blank/placeholder: Dave fills real values (name, symbol,
 * router address, price, royalty receiver, creators) once the artist's
 * router + batch-1 vendor are deployed. supplyCap is the one confirmed
 * number (docs/pnd-surface-second-launch.md: "supply cap 721").
 */
export const ESCAPE_BLUE_DESCRIPTOR: LaunchDescriptor = {
  slug: "escape-blue",
  // Sepolia rehearsal defaults so the artist sees his work in the real UI
  // with editable config. Every field stays editable in the page; paste the
  // deployed SnapshotVendor router into `renderer` after broadcasting
  // DeployEscapeSnapshotSepolia.s.sol (its address depends on the deployer
  // nonce). Real mainnet values (final cap, price, royalty, creators) are
  // set at launch, not here.
  name: "Escape (blue)",
  symbol: "ESCAPE",
  supplyCap: "20",
  royaltyBps: 1000, // 10%, wizard default — confirm with the artist
  royaltyReceiver: "",
  price: "0.01",
  mintStart: "",
  mintEnd: "",
  walletCap: "",
  payoutRecipient: "",
  renderer: "",
  creators: [],
  layoutKind: "edition",
}

export const LAUNCH_DESCRIPTORS: LaunchDescriptor[] = [ESCAPE_BLUE_DESCRIPTOR]

export function getLaunchDescriptor(slug: string): LaunchDescriptor | null {
  const s = slug.trim().toLowerCase()
  return LAUNCH_DESCRIPTORS.find((d) => d.slug === s) ?? null
}

/**
 * The live collection page's layout selector: a data lookup over
 * LAUNCH_DESCRIPTORS' deployedAddress, defaulting to "default" for any
 * collection not tied to a launch descriptor. No per-address component
 * branching — see the module doc comment.
 */
export function getLayoutKindForCollection(address: string): LayoutKind {
  const a = address.trim().toLowerCase()
  const match = LAUNCH_DESCRIPTORS.find((d) => d.deployedAddress?.toLowerCase() === a)
  return match?.layoutKind ?? "default"
}
