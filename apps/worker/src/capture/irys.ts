/**
 * Irys signing + upload. Signing and uploading are separate steps on
 * purpose: an Arweave/Irys data item's id is fixed the moment it's signed,
 * before any network call, so the manifest can reference item ids that were
 * never (in --dry-run) or not yet uploaded.
 */
import { Uploader } from "@irys/upload"
import { Ethereum } from "@irys/upload-ethereum"
import { sha256Hex } from "./hash.ts"
import type { CaptureEnv } from "./config.ts"

export async function buildIrysUploader(
  env: Pick<CaptureEnv, "rpcUrl" | "storageNetwork">,
  privateKey: `0x${string}`,
) {
  return Uploader(Ethereum).withWallet(privateKey.slice(2)).withRpc(env.rpcUrl).network(env.storageNetwork).build()
}

export type IrysUploader = Awaited<ReturnType<typeof buildIrysUploader>>
type DataItem = ReturnType<IrysUploader["bundles"]["createData"]>

export interface Tag {
  name: string
  value: string
}

export interface SignedItem {
  item: DataItem
  itemId: string
  sha256: string
}

export { sha256Hex }

/** Creates and signs a data item locally. No network call. */
export async function signItem(irys: IrysUploader, data: Buffer, tags: Tag[]): Promise<SignedItem> {
  const signer = irys.tokenConfig.getSigner()
  const item = irys.bundles.createData(data, signer, { tags })
  await item.sign(signer)
  return { item, itemId: item.id, sha256: sha256Hex(data) }
}

/** Posts an already-signed item to the bundler node. Real network upload;
 *  never called in --dry-run. */
export async function uploadSignedItem(irys: IrysUploader, signed: SignedItem): Promise<void> {
  await irys.uploader.uploadTransaction(signed.item)
}
