import { keccak256, toBytes, verifyTypedData } from "viem"
import { canonicalizeJson, parseStrictJson, ReleaseSpecValidationError } from "./json.ts"
import type { ArtistSiteDeclarationV1, JsonValue } from "./types.ts"
import {
  addressAt,
  chainReferenceAt,
  dateTimeAt,
  exactKeys,
  hash32At,
  httpsUrlAt,
  literalAt,
  objectAt,
  signatureAt,
  stringAt,
} from "./validate.ts"

export function normalizeArtistSiteDeclaration(input: unknown): ArtistSiteDeclarationV1 {
  const root = objectAt(input, "$")
  exactKeys(root, ["spec", "version", "chain", "artist", "url", "collections", "kit", "issuedAt", "expiresAt", "nonce", "signature"], ["spec", "version", "chain", "artist", "url", "issuedAt", "nonce", "signature"], "$")
  literalAt(root.spec, "pnd.artist-site", "$.spec")
  literalAt(root.version, 1, "$.version")
  const chain = objectAt(root.chain, "$.chain")
  exactKeys(chain, ["namespace", "reference"], ["namespace", "reference"], "$.chain")
  literalAt(chain.namespace, "eip155", "$.chain.namespace")
  const reference = chainReferenceAt(chain.reference, "$.chain.reference")
  const artist = addressAt(root.artist, "$.artist")
  const url = httpsUrlAt(root.url, "$.url")

  let collections: ArtistSiteDeclarationV1["collections"]
  if (root.collections !== undefined) {
    if (!Array.isArray(root.collections)) throw new ReleaseSpecValidationError("expected array", "$.collections")
    if (root.collections.length > 1000) throw new ReleaseSpecValidationError("must contain at most 1000 items", "$.collections")
    collections = [...new Set(root.collections.map((item, index) => addressAt(item, `$.collections[${index}]`)))].sort()
  }

  let kit: ArtistSiteDeclarationV1["kit"]
  if (root.kit !== undefined) {
    const rawKit = objectAt(root.kit, "$.kit")
    exactKeys(rawKit, ["name", "version"], ["name", "version"], "$.kit")
    kit = {
      name: stringAt(rawKit.name, "$.kit.name", { min: 1, max: 200 }),
      version: stringAt(rawKit.version, "$.kit.version", { min: 1, max: 100 }),
    }
  }

  const issuedAt = dateTimeAt(root.issuedAt, "$.issuedAt")
  const expiresAt = root.expiresAt === undefined ? undefined : dateTimeAt(root.expiresAt, "$.expiresAt")
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new ReleaseSpecValidationError("expiresAt must follow issuedAt", "$.expiresAt")
  }
  return {
    spec: "pnd.artist-site",
    version: 1,
    chain: { namespace: "eip155", reference },
    artist,
    url,
    ...(collections === undefined ? {} : { collections }),
    ...(kit === undefined ? {} : { kit }),
    issuedAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    nonce: hash32At(root.nonce, "$.nonce"),
    signature: signatureAt(root.signature, "$.signature"),
  }
}

export function parseArtistSiteDeclarationJson(text: string): ArtistSiteDeclarationV1 {
  return normalizeArtistSiteDeclaration(parseStrictJson(text))
}

export function artistSiteTypedData(declaration: ArtistSiteDeclarationV1) {
  const normalized = normalizeArtistSiteDeclaration(declaration)
  const collectionsHash = keccak256(toBytes(canonicalizeJson((normalized.collections ?? []) as JsonValue)))
  const kitHash = keccak256(toBytes(canonicalizeJson((normalized.kit ?? null) as JsonValue)))
  return {
    domain: {
      name: "PND Artist Site",
      version: "1",
      chainId: BigInt(normalized.chain.reference),
    },
    types: {
      ArtistSite: [
        { name: "artist", type: "address" },
        { name: "urlHash", type: "bytes32" },
        { name: "collectionsHash", type: "bytes32" },
        { name: "kitHash", type: "bytes32" },
        { name: "issuedAt", type: "uint64" },
        { name: "expiresAt", type: "uint64" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ArtistSite" as const,
    message: {
      artist: normalized.artist,
      urlHash: keccak256(toBytes(normalized.url)),
      collectionsHash,
      kitHash,
      issuedAt: BigInt(Math.floor(Date.parse(normalized.issuedAt) / 1000)),
      expiresAt: normalized.expiresAt ? BigInt(Math.floor(Date.parse(normalized.expiresAt) / 1000)) : 0n,
      nonce: normalized.nonce,
    },
  }
}

export async function verifyArtistSiteDeclaration(declaration: ArtistSiteDeclarationV1): Promise<boolean> {
  const normalized = normalizeArtistSiteDeclaration(declaration)
  return verifyTypedData({
    ...artistSiteTypedData(normalized),
    address: normalized.artist,
    signature: normalized.signature,
  })
}
