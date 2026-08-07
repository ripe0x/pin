/**
 * Launch descriptors: reviewed per-launch defaults for the seeded deploy
 * page (app/collections/deploy/[slug]). One entry per launch — see
 * docs/pnd-surface-second-launch.md "Deploy page" section. A descriptor
 * only supplies the form's starting values; every field stays editable in
 * the UI before signing, and owner is never sourced from here (it's always
 * the connected wallet, see SeededDeployWizard).
 *
 * layoutKind selects the live collection page's presentation once
 * deployed (getLayoutKindForCollection below, consumed by the collection
 * page): "edition" for a one-artwork or batch-editions release, "default"
 * for the standard collection page. This is a data lookup, not a hardcoded
 * per-address component branch (see AGENTS.md's note on the Homage
 * anti-pattern).
 *
 * The launch playbook: a new launch is one descriptor entry, not a
 * component-tree edit. Fill the deploy defaults, set layoutKind, and after
 * the artist's createSurface tx lands, record deployedAddress. That single
 * entry lights up both the seeded deploy page and the live collection page's
 * layout; the collection page component tree never changes per launch.
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
  /** The minter's sale ceiling, set in the deploy transaction. "" = no
   *  ceiling, which leaves an open-supply collection with no mint window
   *  unbounded from the moment it deploys; a batched release sets its first
   *  batch size here and raises it per batch afterwards (studio Sale
   *  settings). Distinct from supplyCap, which bounds the collection across
   *  every minter it grants. */
  maxMints: string
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
 * renderer address, price, royalty receiver, creators) once the artist's
 * renderer is deployed.
 *
 * Open supply: the series ships in batches over time with no announced
 * total, so the collection carries no cap and each batch's size is set on
 * the minter (maxMints, raised per batch in the studio Sale Settings tool).
 * An earlier draft read a cap of 721 out of the artist's "721 editions",
 * which meant ERC-721, not a quantity.
 */
export const ESCAPE_BLUE_DESCRIPTOR: LaunchDescriptor = {
  slug: "escape-blue",
  name: "escape (blue)",
  symbol: "",
  supplyCap: "",
  royaltyBps: 1000, // 10%, wizard default — confirm with the artist
  royaltyReceiver: "",
  price: "",
  mintStart: "",
  mintEnd: "",
  // First batch. The artist's renderer currently covers ids 1..12, so a
  // larger ceiling would mint tokens it cannot render. Raised per batch
  // afterwards in the studio Sale settings tool.
  maxMints: "12",
  walletCap: "",
  payoutRecipient: "",
  renderer: "",
  creators: [],
  layoutKind: "edition",
  // The live collection, deployed by the artist through the page above. This
  // is what selects the edition layout for it, which is also what puts the
  // work on the page: the default layout only shows a cover or a minted
  // token's image, so an unminted collection reads as empty.
  deployedAddress: "0xb741055BD0467a5831B8B5f7DF376cdA93a76af1",
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
