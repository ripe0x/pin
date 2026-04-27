/**
 * Run an async mapping with bounded concurrency. Preserves input order in the
 * output. Each worker pulls the next pending item via a shared cursor — no
 * fixed batching, so a slow item doesn't block faster ones in its batch.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = cursor++
        if (i >= items.length) return
        results[i] = await fn(items[i], i)
      }
    },
  )

  await Promise.all(workers)
  return results
}
