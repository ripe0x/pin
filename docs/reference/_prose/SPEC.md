# Prose supplement format

Hand-authored content that `scripts/generate-docs.ts` merges with the checked-in
ABIs (`packages/abi/src/*.ts`, via `@pin/abi`) and
`contracts/deployments.mainnet.json` to produce the final reference pages in
`docs/reference/`. The generator is the enforcement layer: signatures, parameter
lists, event topics, and error lists always come from the ABI; these files carry
only the prose.

One file per generated contract page: `docs/reference/_prose/<ContractName>.md`.
The page list, slugs, and deployment keys live in `CONTRACT_PAGES` inside the
generator, not here.

## File shape

```markdown
---
title: SovereignCollection
---

# summary

One to three paragraphs. What the contract is, what it holds, how it fits the
Collection System (core, factory, a swappable slot, a shared singleton).

# concepts

Optional. Longer explanatory sections. May contain `###` subheadings, tables,
and code blocks. Omit the whole section if the summary says it all.

## function mint

access: permissionless

Behavior prose. What happens step by step, what reverts and why, gotchas.
May contain fenced code examples (```solidity, ```ts, ```bash).

## function totalSupply

One-line (or longer) description. View functions need no `access:` line.

## receive

access: permissionless

Prose for the receive() function, when the contract has one.

## event Minted

When it is emitted and what an indexer should read from it.

## error Underpayment

The condition that raises it and what the caller should do about it.
Keep error prose to one or two sentences.
```

## Rules the generator enforces

- Every ABI entry must have a block: `## function <name>`, `## event <name>`,
  `## error <name>`. Missing blocks fail the build with a list of gaps.
- Block names must match the ABI. Unknown names fail the build (catches typos
  and stale prose).
- Overloaded names must be disambiguated with the parameter types:
  `## function safeTransferFrom(address,address,uint256,bytes)`.
- Every `nonpayable`/`payable` function block must start with an `access:` line.
  Free text, but lead with one of: `permissionless`, `owner-only`, `minter-only`,
  `core-only`, `deployer one-shot`, and say what the gate is and which error
  guards it.
- `{{addr:<key>}}` anywhere in prose is replaced with the mainnet address from
  `contracts/deployments.mainnet.json`. Pre-deploy (empty value) it renders a
  `<KEY_ADDRESS>` placeholder and the build prints a notice; it never fails.

## Inherited standard surface

`SovereignCollection` inherits OpenZeppelin ERC721, ERC2981, Ownable2Step,
Initializable, and ReentrancyGuard, so its ABI carries their functions, events,
and errors (`approve`, `transferFrom`, `Approval`, `OwnableUnauthorizedAccount`,
`ERC721NonexistentToken`, and so on). Document these briefly and honestly: one
sentence naming the standard and the behavior, and where the collection layers
extra rules on top (for example `transferFrom` is standard, but the mint paths
and `burn` are not). Do not re-explain EIP-721 at length; link the concept, state
the local specifics.

## Style

- Mechanically precise. Describe what the code does, not how it feels. Approved
  terms: collection, core, clone, factory, slot, minter, extension minter,
  price strategy, renderer, mint hook, surface, surface share, mint mark,
  entropy, seed, id mode, sequential, pooled, edge, Release Graph, path,
  Token Path, work, work config, freeze metadata, lock work, permanent,
  attribution, roster. Keep contract identifiers verbatim in code and
  signatures (`SURFACE_SHARE_BPS`, `mintToAt`).
- Describe current state only. No history ("was Editions", "replaced X"), no
  PR/audit/issue references.
- Numbers, splits, and addresses come from code, the ABI, or
  `deployments.mainnet.json`, never from memory of other docs. The surface share
  is 10% (`SURFACE_SHARE_BPS = 1000`); state it as read from the constant.
- No em-dashes and no en-dashes. Hyphens in compound words are fine. Bullets
  don't end with periods. Contractions are fine.
- Write "onchain" as one word, never hyphenated. The currency label is "ETH",
  never the glyph.
- Address and transaction links use evm.now:
  `https://evm.now/address/<addr>?chainId=1`, `https://evm.now/tx/<hash>?chainId=1`.
- The Collection System is pre-deploy. Live-read examples use `cast` against a
  free public RPC with a placeholder address, and note that the address lands at
  launch:
  `cast call <COLLECTION_ADDRESS> "totalSupply()(uint256)" --rpc-url https://ethereum-rpc.publicnode.com`.
  For a shared singleton, reference it with `{{addr:collectionFactory}}` so the
  real address substitutes automatically once deployed.
- TypeScript examples use viem and import ABIs from `@pin/abi`
  (`import {sovereignCollectionAbi} from '@pin/abi'`) or fetch `/abis/<Name>.json`.

## Ordering

Write-function blocks render in the order they appear in this file, so put the
main entry points first (for `SovereignCollection`: the mint paths, then config
setters, then the graph/path and withdrawal surface, then the inherited ERC721
transfer/approval functions last). Read functions, events, and errors render
alphabetically regardless of file order.
