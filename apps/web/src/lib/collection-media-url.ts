import { ipfsToHttp } from "./collection"

/** Keep inline renderer output out of React Server Component payloads. */
export function collectionMediaUrl(address: string, uri: string): string {
  return uri.trim().toLowerCase().startsWith("data:")
    ? `/api/media/collection/${encodeURIComponent(address)}`
    : ipfsToHttp(uri)
}

export function rendererMediaUrl(address: string, tokenId: bigint, uri: string): string {
  return uri.trim().toLowerCase().startsWith("data:")
    ? `/api/media/renderer/${encodeURIComponent(address)}/${tokenId.toString()}`
    : ipfsToHttp(uri)
}

export function previewMediaUrl(address: string, seedIndex: number, uri: string): string {
  return uri.trim().toLowerCase().startsWith("data:")
    ? `/api/media/preview/${encodeURIComponent(address)}/${seedIndex}`
    : ipfsToHttp(uri)
}
