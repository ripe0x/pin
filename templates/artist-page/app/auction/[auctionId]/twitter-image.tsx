import OpengraphImage, {
  alt as ogAlt,
  contentType as ogContentType,
  size as ogSize,
} from "./opengraph-image"

export const runtime = "nodejs"
export const revalidate = 60
export const alt = ogAlt
export const size = ogSize
export const contentType = ogContentType

export default OpengraphImage
