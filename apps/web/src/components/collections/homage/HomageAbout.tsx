import type {ReactNode} from "react"

// Shared editorial About content for Homage, used by both the pre-deploy landing
// (HomagePreview.tsx) and the live collection page (app/collections/[address]/page.tsx)
// so the record stays in one place. First block is the lead (no heading, the masthead
// already names the work).
const PC_LINK = "underline decoration-gray-500 underline-offset-2 hover:text-fg"
const ART = "/homage/article" // inline media, copied from the article asset build

// A section is a heading and an ordered list of blocks: paragraphs, a lead, a bold
// sub-label, a bullet list, or an inline media figure. Media files live under ART.
type Block =
  | {t: "lead"; node: ReactNode}
  | {t: "p"; node: ReactNode}
  | {t: "sub"; text: string}
  | {t: "list"; items: ReactNode[]}
  | {t: "media"; src: string; alt: string; caption?: string}

export const ABOUT: {h: string | null; blocks: Block[]}[] = [
  {
    h: null,
    blocks: [
      {
        t: "lead",
        node: "Ten thousand generative artworks, one for every CryptoPunk. Each is composed from the punk’s onchain data and its live market state, rendered fully onchain.",
      },
      {t: "p", node: "One system applied across all 10,000 Punks."},
      {
        t: "media",
        src: "pair-16-512px.gif",
        alt: "Animated pairs of CryptoPunks beside the Homage artwork generated from each.",
      },
    ],
  },
  {
    h: "One structure, 10,000 palettes",
    blocks: [
      {
        t: "p",
        node: (
          <>
            Homage takes its name and structure from Josef Albers’s <em>Homage to the Square</em>.
          </>
        ),
      },
      {
        t: "p",
        node: "Albers kept the composition fixed and changed the relationships between colors. Homage uses the same method across CryptoPunks.",
      },
      {t: "p", node: "The geometry remains consistent."},
      {t: "p", node: "Every Punk supplies a different palette."},
      {
        t: "p",
        node: "The renderer reads the colors in the source Punk, measures how much of each color appears, and arranges the result into nested fields, one ring for every distinct color.",
      },
      {t: "p", node: "The same Punk always produces the same central composition."},
      {
        t: "p",
        node: "The connection to Albers is structural: one fixed format, color as the source of variation, and a complete body of work revealed through repetition.",
      },
      {
        t: "media",
        src: "02_albers_comparison.png",
        alt: "A Josef Albers Homage to the Square beside four Homage works sharing a fixed nested structure with different palettes.",
        caption: "Josef Albers, Homage to the Square from Formulation: Articulation, 1972. Image via Artsy.",
      },
    ],
  },
  {
    h: "From Punk to Homage, completely onchain",
    blocks: [
      {
        t: "p",
        node: (
          <>
            The visual system begins with Josef Albers’s <em>Homage to the Square</em>: nested fields, fixed
            proportions, flat color, and one composition repeated across a larger body of work.
          </>
        ),
      },
      {t: "p", node: "Homage adapts that structure into a system for reading CryptoPunks."},
      {
        t: "p",
        node: (
          <>
            For each Punk, the Homage renderer contract reads its raw pixel data from the{" "}
            <a href="https://evm.now/address/punksdata.eth" target="_blank" rel="noopener noreferrer" className={PC_LINK}>
              PunksData.sol contract
            </a>
            , a public good deployed by{" "}
            <a href="https://x.com/jalilwahdat" target="_blank" rel="noopener noreferrer" className={PC_LINK}>
              @jalilwahdat
            </a>
            , measures how much of each color appears, and arranges the resulting palette into nested
            fields, one ring for every distinct color.
          </>
        ),
      },
      {
        t: "p",
        node: "The geometry and placement remain consistent across the collection. The number of fields, their colors, and the relationships between them come from the individual Punk.",
      },
      {
        t: "p",
        node: "Everything is onchain: the code, the metadata, the source pixel data, and the rendered image. No hosted image server, external metadata service, IPFS asset, or offchain renderer is involved.",
      },
      {
        t: "media",
        src: "03_punk_palette_homage.png",
        alt: "A CryptoPunk, its extracted color palette, and the nested Homage composition generated from it.",
      },
      {
        t: "p",
        node: "Albers selected the colors for each composition. Here, every Punk supplies its own palette and the contract performs the arrangement.",
      },
      {
        t: "p",
        node: "Homage 0 reads Punk 0. Homage 9999 reads Punk 9999. The same visual system is applied across all 10,000.",
      },
    ],
  },
  {
    h: "Permanent pixels, live status",
    blocks: [
      {
        t: "p",
        node: "The central composition is deterministic but the background color reads the source Punk’s current status in the canonical CryptoPunks market.",
      },
      {t: "list", items: ["Unlisted", "Listed", "Carrying a bid", "Wrapped"]},
      {t: "p", node: "The permanent image stays fixed. The Punk’s current status changes the ground around it."},
      {
        t: "media",
        src: "04_live_ground_states.png",
        alt: "The same Homage shown four times with different background colors: unlisted, listed, bid, and wrapped.",
      },
    ],
  },
  {
    h: "Mint, redeem, remint",
    blocks: [
      {
        t: "p",
        node: (
          <>
            Each mint market buys a fixed amount of{" "}
            <a href="https://permanentcollection.art/trade" target="_blank" rel="noopener noreferrer" className={PC_LINK}>
              $111
            </a>{" "}
            at its current price and holds it against the Homage.
          </>
        ),
      },
      {t: "p", node: "Because the amount of $111 is fixed, the ETH required to mint changes with the market."},
      {t: "p", node: "Mint price is determined by"},
      {t: "list", items: ["base mint fee of 0.0042 ETH", "market price of $111 at mint time"]},
      {
        t: "p",
        node: "Each Homage mint market-buys and holds a fixed amount of $111, and the value of those tokens determines the final mint price.",
      },
      {
        t: "p",
        node: "When minting multiples, each additional mint costs 1.1x more as a soft throttle on overminting.",
      },
      {
        t: "media",
        src: "06_mint_redeem_loop.png",
        alt: "A loop: a fixed amount of $111 mints an Homage; burning it returns the $111 and frees the ID to mint again.",
      },
      {t: "sub", text: "Redeeming $111"},
      {
        t: "p",
        node: "The holder can burn the Homage and redeem the fixed amount of $111 in full. A separate redemption fee of 0.001 ETH applies.",
      },
      {
        t: "p",
        node: "Burning removes the active token and returns its ID to the available set. The central composition is tied to the Punk, so it returns when the ID is minted again.",
      },
      {
        t: "p",
        node: "There are 10,000 possible Homage IDs, one for every Punk. Only one active Homage can exist for an ID at a time.",
      },
    ],
  },
  {
    h: "Permanent Collection",
    blocks: [
      {
        t: "p",
        node: (
          <>
            $111 connects Homage to{" "}
            <a href="https://permanentcollection.art" target="_blank" rel="noopener noreferrer" className={PC_LINK}>
              Permanent Collection
            </a>
            , a protocol designed to acquire, permanently hold, and publicly display one CryptoPunk for every
            trait.
          </>
        ),
      },
      {
        t: "p",
        node: "Each Homage mint buys $111 through its official market. Trading fees from that market feed the Permanent Collection live bid. At launch, a portion of each Homage mint and redemption fee will also contribute to the bid.",
      },
      {t: "p", node: "Homage maps all 10,000 Punk IDs."},
      {t: "p", node: "Permanent Collection builds toward one Punk for each of the 111 traits."},
      {t: "p", node: "Holding an Homage or $111 does not provide ownership of the vault or any Punk it holds."},
    ],
  },
]

// Renders the About sections (heading text per section + blocks). Does not render
// the "About this work" band label or wrap in a container — callers own that layout
// (the two pages use different width/column chrome around this content).
export function HomageAboutSections() {
  return (
    <>
      {ABOUT.map((s, i) => (
        <section key={i} className="space-y-4">
          {s.h && <h3 className="text-sm font-medium tracking-tight text-fg">{s.h}</h3>}
          {s.blocks.map((b, j) => {
            switch (b.t) {
              case "lead":
                return (
                  <p key={j} className="text-lg leading-relaxed text-fg sm:text-xl">
                    {b.node}
                  </p>
                )
              case "p":
                return (
                  <p key={j} className="text-sm leading-relaxed text-fg-muted">
                    {b.node}
                  </p>
                )
              case "sub":
                return (
                  <p key={j} className="pt-2 text-sm font-medium tracking-tight text-fg">
                    {b.text}
                  </p>
                )
              case "list":
                return (
                  <ul key={j} className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-fg-muted">
                    {b.items.map((it, k) => (
                      <li key={k}>{it}</li>
                    ))}
                  </ul>
                )
              case "media":
                return (
                  <figure key={j} className="pt-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`${ART}/${b.src}`}
                      alt={b.alt}
                      className="w-full rounded-lg border border-gray-200"
                      loading="lazy"
                    />
                    {b.caption && (
                      <figcaption className="mt-2 text-[10px] font-mono uppercase tracking-wider text-gray-400">
                        {b.caption}
                      </figcaption>
                    )}
                  </figure>
                )
            }
          })}
        </section>
      ))}
    </>
  )
}

// Full About block: the section heading + all sections, spaced as a single column.
// Used wherever a page wants the whole record in its default layout.
export function HomageAbout({headingClassName}: {headingClassName: string}) {
  return (
    <div className="space-y-8">
      <h2 className={headingClassName}>About this work</h2>
      <HomageAboutSections />
    </div>
  )
}
