import { keccak256, toBytes, verifyTypedData, type Address, type Hex } from "viem"
import { canonicalizeJson, parseStrictJson, ReleaseSpecValidationError } from "./json.ts"
import type {
  ArtistLink,
  JsonValue,
  ManifestAuthorshipV1,
  PortableMediaRef,
  ReleaseAdapterBinding,
  ReleaseManifestV1,
  UnsignedReleaseManifestV1,
} from "./types.ts"
import {
  absoluteUrlAt,
  addressAt,
  capabilityAt,
  chainReferenceAt,
  dateTimeAt,
  exactKeys,
  hash32At,
  jsonRecordAt,
  literalAt,
  objectAt,
  optionalString,
  positiveIntegerAt,
  signatureAt,
  stringAt,
} from "./validate.ts"

const TOP_KEYS = ["spec", "version", "release", "declaration", "presentation", "capabilities", "extensions", "authorship"] as const

function mediaRefAt(value: unknown, path: string): PortableMediaRef {
  const object = objectAt(value, path)
  exactKeys(object, ["uri", "mediaType", "sha256", "width", "height", "alt"], ["uri"], path)
  const uri = stringAt(object.uri, `${path}.uri`, { min: 1, max: 4096 })
  const mediaType = optionalString(object, "mediaType", path, { max: 200 })
  const sha256Raw = optionalString(object, "sha256", path, { pattern: /^[0-9a-fA-F]{64}$/ })
  const width = object.width === undefined ? undefined : positiveIntegerAt(object.width, `${path}.width`)
  const height = object.height === undefined ? undefined : positiveIntegerAt(object.height, `${path}.height`)
  const alt = optionalString(object, "alt", path, { max: 1000 })
  return {
    uri,
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(sha256Raw === undefined ? {} : { sha256: sha256Raw.toLowerCase() }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(alt === undefined ? {} : { alt }),
  }
}

function mediaArray(value: unknown, path: string, max: number): PortableMediaRef[] {
  if (!Array.isArray(value)) throw new ReleaseSpecValidationError("expected array", path)
  if (value.length > max) throw new ReleaseSpecValidationError(`must contain at most ${max} items`, path)
  return value.map((item, index) => mediaRefAt(item, `${path}[${index}]`))
}

function artistLinkAt(value: unknown, path: string): ArtistLink {
  const object = objectAt(value, path)
  exactKeys(object, ["label", "url"], ["label", "url"], path)
  return {
    label: stringAt(object.label, `${path}.label`, { min: 1, max: 100 }),
    url: absoluteUrlAt(object.url, `${path}.url`),
  }
}

function adapterAt(value: unknown, path: string): ReleaseAdapterBinding {
  const object = objectAt(value, path)
  exactKeys(object, ["capability", "adapter", "target", "config"], ["capability", "adapter", "target"], path)
  const rawTarget = stringAt(object.target, `${path}.target`)
  const target = ["collection", "primary-minter", "collection-renderer"].includes(rawTarget)
    ? (rawTarget as ReleaseAdapterBinding["target"])
    : addressAt(rawTarget, `${path}.target`)
  return {
    capability: capabilityAt(object.capability, `${path}.capability`),
    adapter: capabilityAt(object.adapter, `${path}.adapter`),
    target,
    ...(object.config === undefined ? {} : { config: jsonRecordAt(object.config, `${path}.config`) }),
  }
}

function normalizeUnsigned(input: unknown): UnsignedReleaseManifestV1 {
  const root = objectAt(input, "$")
  exactKeys(root, TOP_KEYS, ["spec", "version", "release", "declaration", "capabilities"], "$")
  literalAt(root.spec, "pnd.release", "$.spec")
  literalAt(root.version, 1, "$.version")

  const release = objectAt(root.release, "$.release")
  exactKeys(release, ["id", "chain", "collection", "protocol"], ["id", "chain", "collection", "protocol"], "$.release")
  const chain = objectAt(release.chain, "$.release.chain")
  exactKeys(chain, ["namespace", "reference"], ["namespace", "reference"], "$.release.chain")
  literalAt(chain.namespace, "eip155", "$.release.chain.namespace")
  const chainReference = chainReferenceAt(chain.reference, "$.release.chain.reference")
  const collection = addressAt(release.collection, "$.release.collection")
  const expectedId = `pnd:${chainReference}:${collection}:c`
  const suppliedId = stringAt(release.id, "$.release.id")
  if (suppliedId.toLowerCase() !== expectedId) {
    throw new ReleaseSpecValidationError(`expected ${JSON.stringify(expectedId)}`, "$.release.id")
  }
  const protocol = objectAt(release.protocol, "$.release.protocol")
  exactKeys(protocol, ["family", "abi", "factory"], ["family", "abi"], "$.release.protocol")
  literalAt(protocol.family, "surface", "$.release.protocol.family")
  const abi = capabilityAt(protocol.abi, "$.release.protocol.abi")
  const factory = protocol.factory === undefined ? undefined : addressAt(protocol.factory, "$.release.protocol.factory")

  const declaration = objectAt(root.declaration, "$.declaration")
  exactKeys(
    declaration,
    ["artist", "title", "summary", "statement", "process", "announcedSchedule", "media", "links"],
    ["artist", "title"],
    "$.declaration",
  )
  const artist = addressAt(declaration.artist, "$.declaration.artist")
  const title = stringAt(declaration.title, "$.declaration.title", { min: 1, max: 200 })
  if (title.trim().length === 0) throw new ReleaseSpecValidationError("must contain visible text", "$.declaration.title")
  const summary = optionalString(declaration, "summary", "$.declaration", { max: 1000 })
  const statement = optionalString(declaration, "statement", "$.declaration", { max: 50_000 })
  const process = optionalString(declaration, "process", "$.declaration", { max: 50_000 })

  let announcedSchedule: ReleaseManifestV1["declaration"]["announcedSchedule"]
  if (declaration.announcedSchedule !== undefined) {
    const schedule = objectAt(declaration.announcedSchedule, "$.declaration.announcedSchedule")
    exactKeys(schedule, ["opensAt", "closesAt", "note"], [], "$.declaration.announcedSchedule")
    if (Object.keys(schedule).length === 0) throw new ReleaseSpecValidationError("must not be empty", "$.declaration.announcedSchedule")
    const opensAt = schedule.opensAt === undefined ? undefined : dateTimeAt(schedule.opensAt, "$.declaration.announcedSchedule.opensAt")
    const closesAt = schedule.closesAt === undefined ? undefined : dateTimeAt(schedule.closesAt, "$.declaration.announcedSchedule.closesAt")
    if (opensAt && closesAt && Date.parse(closesAt) < Date.parse(opensAt)) {
      throw new ReleaseSpecValidationError("closesAt precedes opensAt", "$.declaration.announcedSchedule")
    }
    const note = optionalString(schedule, "note", "$.declaration.announcedSchedule", { max: 1000 })
    announcedSchedule = {
      ...(opensAt === undefined ? {} : { opensAt }),
      ...(closesAt === undefined ? {} : { closesAt }),
      ...(note === undefined ? {} : { note }),
    }
  }

  let media: ReleaseManifestV1["declaration"]["media"]
  if (declaration.media !== undefined) {
    const rawMedia = objectAt(declaration.media, "$.declaration.media")
    exactKeys(rawMedia, ["cover", "hero", "process", "social"], [], "$.declaration.media")
    media = {
      ...(rawMedia.cover === undefined ? {} : { cover: mediaRefAt(rawMedia.cover, "$.declaration.media.cover") }),
      ...(rawMedia.hero === undefined ? {} : { hero: mediaRefAt(rawMedia.hero, "$.declaration.media.hero") }),
      ...(rawMedia.process === undefined ? {} : { process: mediaArray(rawMedia.process, "$.declaration.media.process", 100) }),
      ...(rawMedia.social === undefined ? {} : { social: mediaArray(rawMedia.social, "$.declaration.media.social", 20) }),
    }
  }

  let links: ArtistLink[] | undefined
  if (declaration.links !== undefined) {
    if (!Array.isArray(declaration.links)) throw new ReleaseSpecValidationError("expected array", "$.declaration.links")
    if (declaration.links.length > 30) throw new ReleaseSpecValidationError("must contain at most 30 items", "$.declaration.links")
    links = declaration.links.map((link, index) => artistLinkAt(link, `$.declaration.links[${index}]`))
  }

  let presentation: ReleaseManifestV1["presentation"]
  if (root.presentation !== undefined) {
    const rawPresentation = objectAt(root.presentation, "$.presentation")
    exactKeys(rawPresentation, ["layout", "theme", "aspectRatio"], [], "$.presentation")
    const layouts = ["default", "edition", "generative", "custom"] as const
    const layout = rawPresentation.layout === undefined
      ? undefined
      : layouts.find((item) => item === rawPresentation.layout)
    if (rawPresentation.layout !== undefined && !layout) {
      throw new ReleaseSpecValidationError("unsupported layout", "$.presentation.layout")
    }
    let theme: NonNullable<ReleaseManifestV1["presentation"]>["theme"]
    if (rawPresentation.theme !== undefined) {
      const rawTheme = objectAt(rawPresentation.theme, "$.presentation.theme")
      exactKeys(rawTheme, ["accent", "background", "foreground", "font"], [], "$.presentation.theme")
      theme = {
        ...(optionalString(rawTheme, "accent", "$.presentation.theme", { max: 100 }) === undefined ? {} : { accent: rawTheme.accent as string }),
        ...(optionalString(rawTheme, "background", "$.presentation.theme", { max: 100 }) === undefined ? {} : { background: rawTheme.background as string }),
        ...(optionalString(rawTheme, "foreground", "$.presentation.theme", { max: 100 }) === undefined ? {} : { foreground: rawTheme.foreground as string }),
        ...(optionalString(rawTheme, "font", "$.presentation.theme", { max: 200 }) === undefined ? {} : { font: rawTheme.font as string }),
      }
    }
    const aspectRatio = optionalString(rawPresentation, "aspectRatio", "$.presentation", { max: 100 })
    presentation = {
      ...(layout === undefined ? {} : { layout }),
      ...(theme === undefined ? {} : { theme }),
      ...(aspectRatio === undefined ? {} : { aspectRatio }),
    }
  }

  const rawCapabilities = objectAt(root.capabilities, "$.capabilities")
  exactKeys(rawCapabilities, ["required", "optional", "adapters"], ["required", "adapters"], "$.capabilities")
  if (!Array.isArray(rawCapabilities.required)) throw new ReleaseSpecValidationError("expected array", "$.capabilities.required")
  if (!Array.isArray(rawCapabilities.adapters)) throw new ReleaseSpecValidationError("expected array", "$.capabilities.adapters")
  const required = [...new Set(rawCapabilities.required.map((item, index) => capabilityAt(item, `$.capabilities.required[${index}]`)))].sort()
  let optional: string[] | undefined
  if (rawCapabilities.optional !== undefined) {
    if (!Array.isArray(rawCapabilities.optional)) throw new ReleaseSpecValidationError("expected array", "$.capabilities.optional")
    optional = [...new Set(rawCapabilities.optional.map((item, index) => capabilityAt(item, `$.capabilities.optional[${index}]`)))].sort()
    const overlap = optional.find((item) => required.includes(item))
    if (overlap) throw new ReleaseSpecValidationError(`${overlap} is both required and optional`, "$.capabilities")
  }
  const adapters = rawCapabilities.adapters.map((item, index) => adapterAt(item, `$.capabilities.adapters[${index}]`))
    .sort((a, b) => a.capability.localeCompare(b.capability) || a.adapter.localeCompare(b.adapter) || a.target.localeCompare(b.target))
  const adapterCapabilities = new Set<string>()
  for (const adapter of adapters) {
    if (adapterCapabilities.has(adapter.capability)) {
      throw new ReleaseSpecValidationError(`duplicate adapter for ${adapter.capability}`, "$.capabilities.adapters")
    }
    adapterCapabilities.add(adapter.capability)
  }

  let extensions: Record<string, JsonValue> | undefined
  if (root.extensions !== undefined) {
    extensions = jsonRecordAt(root.extensions, "$.extensions")
    for (const key of Object.keys(extensions)) {
      if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(key)) {
        throw new ReleaseSpecValidationError("extension keys must be package-qualified", `$.extensions.${key}`)
      }
    }
  }

  return {
    spec: "pnd.release",
    version: 1,
    release: {
      id: expectedId,
      chain: { namespace: "eip155", reference: chainReference },
      collection,
      protocol: { family: "surface", abi, ...(factory === undefined ? {} : { factory }) },
    },
    declaration: {
      artist,
      title,
      ...(summary === undefined ? {} : { summary }),
      ...(statement === undefined ? {} : { statement }),
      ...(process === undefined ? {} : { process }),
      ...(announcedSchedule === undefined ? {} : { announcedSchedule }),
      ...(media === undefined ? {} : { media }),
      ...(links === undefined ? {} : { links }),
    },
    ...(presentation === undefined ? {} : { presentation }),
    capabilities: {
      required,
      ...(optional === undefined ? {} : { optional }),
      adapters,
    },
    ...(extensions === undefined ? {} : { extensions }),
  }
}

function authorshipAt(value: unknown, artist: Address): ManifestAuthorshipV1 {
  const object = objectAt(value, "$.authorship")
  exactKeys(object, ["scheme", "signer", "issuedAt", "digest", "signature"], ["scheme", "signer", "issuedAt", "digest", "signature"], "$.authorship")
  literalAt(object.scheme, "eip712", "$.authorship.scheme")
  const signer = addressAt(object.signer, "$.authorship.signer")
  if (signer !== artist) throw new ReleaseSpecValidationError("signer must equal declaration.artist", "$.authorship.signer")
  return {
    scheme: "eip712",
    signer,
    issuedAt: dateTimeAt(object.issuedAt, "$.authorship.issuedAt"),
    digest: hash32At(object.digest, "$.authorship.digest"),
    signature: signatureAt(object.signature, "$.authorship.signature"),
  }
}

export function normalizeReleaseManifest(input: unknown): ReleaseManifestV1 {
  const unsigned = normalizeUnsigned(input)
  const root = objectAt(input, "$")
  if (root.authorship === undefined) return unsigned
  const authorship = authorshipAt(root.authorship, unsigned.declaration.artist)
  const digest = releaseManifestDigest(unsigned)
  if (authorship.digest !== digest) throw new ReleaseSpecValidationError("digest does not match normalized unsigned manifest", "$.authorship.digest")
  return { ...unsigned, authorship }
}

export function parseReleaseManifestJson(text: string): ReleaseManifestV1 {
  return normalizeReleaseManifest(parseStrictJson(text))
}

export function unsignedReleaseManifest(manifest: ReleaseManifestV1): UnsignedReleaseManifestV1 {
  const { authorship: _authorship, ...unsigned } = manifest
  return unsigned
}

export function canonicalReleaseManifest(manifest: ReleaseManifestV1 | UnsignedReleaseManifestV1): string {
  return canonicalizeJson(normalizeUnsigned(manifest) as unknown as JsonValue)
}

export function releaseManifestDigest(manifest: ReleaseManifestV1 | UnsignedReleaseManifestV1): Hex {
  return keccak256(toBytes(canonicalReleaseManifest(manifest)))
}

export function releaseManifestTypedData(manifest: ReleaseManifestV1) {
  if (!manifest.authorship) throw new ReleaseSpecValidationError("manifest is unsigned", "$.authorship")
  return {
    domain: {
      name: "PND Portable Release",
      version: "1",
      chainId: BigInt(manifest.release.chain.reference),
    },
    types: {
      ReleaseManifest: [
        { name: "artist", type: "address" },
        { name: "collection", type: "address" },
        { name: "manifestDigest", type: "bytes32" },
        { name: "issuedAt", type: "uint64" },
      ],
    },
    primaryType: "ReleaseManifest" as const,
    message: {
      artist: manifest.declaration.artist,
      collection: manifest.release.collection,
      manifestDigest: manifest.authorship.digest,
      issuedAt: BigInt(Math.floor(Date.parse(manifest.authorship.issuedAt) / 1000)),
    },
  }
}

export async function verifyReleaseManifestAuthorship(manifest: ReleaseManifestV1): Promise<boolean> {
  const normalized = normalizeReleaseManifest(manifest)
  if (!normalized.authorship) return false
  return verifyTypedData({
    ...releaseManifestTypedData(normalized),
    address: normalized.authorship.signer,
    signature: normalized.authorship.signature,
  })
}
