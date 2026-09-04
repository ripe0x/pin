import assert from "node:assert/strict"
import test from "node:test"
import { toPreserveDiscoveredToken } from "./preserve-token.ts"

const CID_METADATA = "QmYwAPJzv5CZsnAzt8auVZRnG3xYBXXr7oJX8wQqjWjWqG"
const CID_MEDIA = "bafybeigdyrzt5sfp7udm7hu76rmw4muw5y4x4gtr5p7h4rjdugqjzyqoxa"

test("maps indexed Foundation rows to the Preserve DiscoveredToken contract", () => {
  const token = toPreserveDiscoveredToken(
    {
      contract: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD",
      token_id: "7",
      name: "A work",
      description: "A description",
      image_url: `ipfs://${CID_MEDIA}/art.png`,
      animation_url: null,
      raw_uri: `https://ipfs.io/ipfs/${CID_METADATA}/metadata.json`,
    },
    "0x1234567890123456789012345678901234567890",
  )

  assert.equal(token.contract, "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd")
  assert.equal(token.tokenId, "7")
  assert.equal(token.creator, "0x1234567890123456789012345678901234567890")
  assert.equal(token.platform, "foundation")
  assert.equal(token.metadata?.name, "A work")
  assert.equal(token.metadata?.image, `ipfs://${CID_MEDIA}/art.png`)
  assert.equal(token.metadataCid, CID_METADATA)
  assert.equal(token.mediaCid, CID_MEDIA)
  assert.match(token.mediaHttpUrl ?? "", new RegExp(`${CID_MEDIA}/art\\.png$`))
})

test("keeps non-IPFS indexed media visible without inventing pinnable CIDs", () => {
  const token = toPreserveDiscoveredToken(
    {
      contract: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      token_id: "8",
      name: null,
      description: null,
      image_url: "https://example.com/art.png",
      animation_url: null,
      raw_uri: "data:application/json,{}",
    },
    "0x1234567890123456789012345678901234567890",
  )

  assert.equal(token.mediaHttpUrl, "https://example.com/art.png")
  assert.equal(token.metadataCid, null)
  assert.equal(token.mediaCid, null)
})
