// Reuse the OpenGraph image content for the Twitter card. Re-exporting
// from "./opengraph-image" doesn't let Next pick up the config fields
// (runtime, size, etc.), so we duplicate the literals here and import
// the default export.
import OpengraphImage, {
  alt as ogAlt,
  contentType as ogContentType,
  size as ogSize,
} from "./opengraph-image"

export const runtime = "nodejs"
export const alt = ogAlt
export const size = ogSize
export const contentType = ogContentType

export default OpengraphImage
