// Token detail for a homage — the derived work beside the punk it came from.
//
// Server component. Renders inside the terminal skin (`.dark .homage-terminal
// .collection-homage-skin`, applied by the page) so it matches /mint/homage, the
// collection page, and the redeem page. It deliberately drops the generic PND
// token chrome (Mint Mark, a top-level seed card, "Standard: ERC721", the "pure
// function of chain state" copy) and surfaces what a homage actually carries: the
// source punk, its traits, and the homage's own derived color count. The seed and
// contract plumbing collapse into one "Onchain details" disclosure at the bottom.

import Link from "next/link"
import {type Address} from "viem"
import {ArtistName} from "./ArtistName"
import {HomageArtStage} from "./HomageArtStage"
import {HomageRedeemLink} from "./HomageRedeemLink"
import {CopyAddressButton} from "@/components/CopyAddressButton"
import {PND_CHAIN_ID, evmNowAddressUrl, ipfsToHttp, shortAddress} from "@/lib/collection"
import type {HomageTokenFacts} from "@/lib/homage/token-facts"

const META = "text-[10px] font-mono uppercase tracking-wider text-gray-400"

function Cell({label, value}: {label: string; value: string}) {
  return (
    <div className="px-3 py-2.5">
      <div className={META}>{label}</div>
      <div className="mt-1 font-mono text-[13px] text-fg">{value}</div>
    </div>
  )
}

export function HomageTokenDetail({
  collection,
  tokenId,
  owner,
  art,
  animationUrl,
  punkImageSrc,
  punkBg,
  facts,
  seed,
  renderer,
  isRendererLocked,
  onchainPfpSrc,
}: {
  collection: Address
  tokenId: bigint
  owner: Address | null
  art: string
  animationUrl: string | null
  punkImageSrc: string | null
  punkBg: string | null
  facts: HomageTokenFacts
  seed: `0x${string}` | null
  renderer: Address
  isRendererLocked: boolean
  onchainPfpSrc: string | null
}) {
  const id = tokenId.toString()
  const dash = "—"

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1.15fr_1fr]">
      {/* The homage — large; click plays the onchain animation, the row below holds
          the quiet classic/pfp toggle + PNG export. */}
      <div className="flex flex-col px-6 pb-8 pt-24 lg:sticky lg:top-0 lg:h-screen lg:justify-center lg:px-12 lg:pb-12 lg:pt-24">
        <HomageArtStage
          art={ipfsToHttp(art)}
          animationUrl={animationUrl}
          tokenId={id}
          onchainPfpSrc={onchainPfpSrc}
        />
      </div>

      {/* The record — lean, homage-specific. */}
      <aside className="border-gray-200 px-6 pb-16 pt-6 lg:min-h-screen lg:border-l lg:px-10 lg:pb-20 lg:pt-24">
        <nav className={`mb-8 ${META} lg:mb-12`}>
          <Link href={`/collections/${collection}`} className="hover:text-fg">
            ← Homage to the Punk
          </Link>
        </nav>

        <header>
          <h1 className="text-4xl leading-none sm:text-5xl">Homage to Punk {id}</h1>
        </header>

        <div className={`mt-4 ${META}`}>
          {owner ? (
            <>
              held by{" "}
              <a
                href={evmNowAddressUrl(owner, PND_CHAIN_ID)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[color:var(--accent)] underline underline-offset-2 hover:text-fg"
              >
                <ArtistName address={owner} />
              </a>
            </>
          ) : (
            "owner unknown"
          )}
        </div>

        {/* Derived from — the source punk. */}
        <a
          href={`https://cryptopunks.app/cryptopunks/details/${id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 flex items-center gap-3 border border-gray-200 p-3 transition-colors hover:border-gray-300"
        >
          {punkImageSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={punkImageSrc}
              alt={`CryptoPunk ${id}`}
              style={punkBg ? {background: punkBg} : undefined}
              className="h-14 w-14 shrink-0 border border-gray-200 bg-bg [image-rendering:pixelated]"
            />
          ) : (
            <div
              style={punkBg ? {background: punkBg} : undefined}
              className="h-14 w-14 shrink-0 border border-gray-200 bg-bg"
            />
          )}
          <div>
            <div className={META}>derived from</div>
            <div className="mt-0.5 font-mono text-[13px] text-fg">CryptoPunk {id} ↗</div>
          </div>
        </a>

        {/* Traits — the four things the token actually carries. */}
        <div className="mt-6 grid grid-cols-2 border-l border-t border-gray-200">
          <div className="border-b border-r border-gray-200">
            <Cell label="type" value={facts.punkType ?? dash} />
          </div>
          <div className="border-b border-r border-gray-200">
            <Cell label="colors" value={facts.colorCount != null ? String(facts.colorCount) : dash} />
          </div>
          <div className="border-b border-r border-gray-200">
            {/* The renderer emits one Punk Accessory trait per accessory. Keep them
                separate here rather than joining them back into a sentence. */}
            <div className="px-3 py-2.5">
              <div className={META}>
                {facts.accessories.length === 1 ? "accessory" : "accessories"}
              </div>
              {facts.accessories.length ? (
                <ul className="mt-1 space-y-0.5">
                  {facts.accessories.map((a) => (
                    <li key={a} className="font-mono text-[13px] text-fg">
                      {a}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-1 font-mono text-[13px] text-fg">None</div>
              )}
            </div>
          </div>
          <div className="border-b border-r border-gray-200">
            <Cell label="status" value={facts.status ?? dash} />
          </div>
        </div>

        {/* Redeem — present but quiet, and only for the token's owner. */}
        <HomageRedeemLink collection={collection} owner={owner} />

        {/* Onchain details — seed, contract, standard: reachable, not in your face. */}
        <details className="group mt-8 border-t border-gray-200 pt-4">
          <summary className={`flex cursor-pointer list-none items-center gap-1.5 ${META} hover:text-fg`}>
            <span className="transition-transform group-open:rotate-90">›</span>
            Onchain details
          </summary>
          <dl className="mt-4 space-y-3 font-mono text-[11px]">
            {seed && (
              <div>
                <dt className={META}>Seed</dt>
                <dd className="mt-1 flex items-center gap-2">
                  <span className="break-all text-fg-muted">{seed}</span>
                  <CopyAddressButton address={seed} />
                </dd>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-4">
              <dt className={META}>Standard</dt>
              <dd className="tabular-nums text-fg-muted">ERC-721</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className={META}>Renderer</dt>
              <dd className="text-right text-fg-muted">
                <a
                  href={evmNowAddressUrl(renderer, PND_CHAIN_ID)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-fg"
                >
                  {shortAddress(renderer)} ↗
                </a>
                {isRendererLocked ? " · locked" : ""}
              </dd>
            </div>
            <div className="flex flex-col gap-2 pt-1">
              <a
                href={`https://opensea.io/assets/ethereum/${collection}/${id}`}
                target="_blank"
                rel="noopener noreferrer"
                className={`${META} underline hover:text-fg`}
              >
                Token on OpenSea ↗
              </a>
              <a
                href={evmNowAddressUrl(collection, PND_CHAIN_ID)}
                target="_blank"
                rel="noopener noreferrer"
                className={`${META} underline hover:text-fg`}
              >
                Contract on evm.now ↗
              </a>
            </div>
          </dl>
        </details>
      </aside>
    </div>
  )
}
