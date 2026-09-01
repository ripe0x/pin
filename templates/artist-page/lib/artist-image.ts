export function remoteImageResponseIsUsable(status: number, contentType: string | null): boolean {
  return status >= 200 && status < 300 && Boolean(contentType?.toLowerCase().startsWith("image/"))
}
