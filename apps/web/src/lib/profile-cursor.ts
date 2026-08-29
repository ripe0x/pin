export type ProfileCursor = {
  block: string
  logIndex: string
  contract: string
  tokenId: string
}

export function encodeProfileCursor(cursor: ProfileCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
}

export function decodeProfileCursor(raw: string | null): ProfileCursor | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<ProfileCursor>
    if (
      typeof parsed.block !== "string" || !/^\d+$/.test(parsed.block) ||
      typeof parsed.logIndex !== "string" || !/^-?\d+$/.test(parsed.logIndex) ||
      typeof parsed.contract !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(parsed.contract) ||
      typeof parsed.tokenId !== "string" || !/^\d+$/.test(parsed.tokenId)
    ) return null
    return {
      block: parsed.block,
      logIndex: parsed.logIndex,
      contract: parsed.contract.toLowerCase(),
      tokenId: parsed.tokenId,
    }
  } catch {
    return null
  }
}
