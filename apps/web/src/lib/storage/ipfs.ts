/**
 * IPFS storage for PND Editions, via the artist's own Pinata account.
 *
 * BYO key: the JWT lives only in the browser (same localStorage slot as
 * /preserve and /muri) and never touches PND's servers. Wraps the existing
 * `PinataProvider.uploadFile` primitive (added for MURI) into the shared
 * storage-result shape so the create flow treats it like any other backend.
 *
 * Not permanent: a Pinata pin lapses if the artist stops paying. The default
 * editions backend is Arweave (see ./arweave.ts); IPFS is the BYO-key option.
 */

import { ipfsToGatewayUrl } from "@pin/shared"
import { PinataProvider } from "@/lib/pinning/pinata"
import type { StorageUploadResult } from "./types"

export async function uploadToIpfs(
  file: File,
  jwt: string,
): Promise<StorageUploadResult> {
  const { cid } = await new PinataProvider(jwt).uploadFile(file, file.name)
  return {
    backend: "ipfs",
    uri: `ipfs://${cid}`,
    gatewayUrl: ipfsToGatewayUrl(cid),
    bytes: file.size,
  }
}
