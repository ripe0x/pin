"use client"

/**
 * One-time repair for WalletConnect sessions poisoned by a relative RPC URL.
 *
 * Older builds configured wagmi's mainnet transport as a RELATIVE proxy path
 * ("/api/rpc"). WalletConnect's UniversalProvider persists the connected
 * session's rpcMap — including that URL — in IndexedDB:
 *
 *   WALLET_CONNECT_V2_INDEXED_DB
 *     -> store "keyvaluestorage"
 *       -> key "wc@2:universal_provider:namespaces<topic>"        (active)
 *       -> key "wc@2:universal_provider:optionalNamespaces<topic>"
 *          value JSON: { eip155: { rpcMap: { "1": "/api/rpc", ... }, ... } }
 *
 * On the next connect/restore, `UniversalProvider.checkStorage()` reads those
 * stored namespaces and `createProviders()` rebuilds an HTTP provider from the
 * stored rpcMap. A relative "/api/rpc" makes `@walletconnect/jsonrpc-http-
 * connection` throw "Provided URL is not compatible with HTTP connection:
 * /api/rpc", which silently aborts the WalletConnect AND Rainbow connect flows.
 *
 * The transport is now absolute (see lib/wagmi.ts), so new sessions store an
 * absolute URL — but a session created on an old build stays poisoned across
 * reloads (IndexedDB survives a hard refresh), and the connect path reads the
 * URL from this stored session, never from the live config. So repair it here:
 * rewrite any relative rpcMap URL to an absolute same-origin URL, in place,
 * without disconnecting the user. Runs once per browser, before WalletConnect
 * initializes its provider.
 */

const WC_DB = "WALLET_CONNECT_V2_INDEXED_DB"
const WC_STORE = "keyvaluestorage"
const DONE_FLAG = "pnd:wc-rpc-repair:v1"

/** Rewrite relative rpcMap URLs (e.g. "/api/rpc") to absolute same-origin. */
function repairNamespaces(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false
  let changed = false
  for (const ns of Object.values(parsed as Record<string, unknown>)) {
    const rpcMap = (ns as { rpcMap?: Record<string, unknown> } | null)?.rpcMap
    if (!rpcMap || typeof rpcMap !== "object") continue
    for (const ref of Object.keys(rpcMap)) {
      const url = rpcMap[ref]
      if (typeof url === "string" && url.startsWith("/")) {
        rpcMap[ref] = new URL(url, window.location.origin).toString()
        changed = true
      }
    }
  }
  return changed
}

/** Open the WC IndexedDB WITHOUT creating it if absent (nothing to repair). */
function openExisting(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(WC_DB)
    } catch {
      return resolve(null)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onupgradeneeded = () => {
      // DB didn't exist — this visitor never used WalletConnect. Abort so we
      // don't leave behind an empty WC database.
      try {
        req.transaction?.abort()
      } catch {
        /* ignore */
      }
      resolve(null)
    }
  })
}

export async function repairWalletConnectRpcStorage(): Promise<void> {
  if (typeof window === "undefined" || !window.indexedDB) return
  try {
    if (window.localStorage.getItem(DONE_FLAG) === "1") return
  } catch {
    /* localStorage blocked — fall through and still attempt the repair */
  }

  try {
    const db = await openExisting()
    if (!db) {
      markDone()
      return
    }
    if (!db.objectStoreNames.contains(WC_STORE)) {
      db.close()
      markDone()
      return
    }

    await new Promise<void>((resolve) => {
      const tx = db.transaction(WC_STORE, "readwrite")
      const store = tx.objectStore(WC_STORE)
      const cursorReq = store.openCursor()
      cursorReq.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result
        if (!cursor) return
        const key = String(cursor.key)
        // Both the active and optional namespace blobs can carry the rpcMap;
        // createProviders() merges them, so repair either.
        if (/namespaces/i.test(key)) {
          const raw = cursor.value
          let parsed: unknown
          try {
            parsed = typeof raw === "string" ? JSON.parse(raw) : raw
          } catch {
            parsed = undefined
          }
          if (parsed !== undefined && repairNamespaces(parsed)) {
            store.put(typeof raw === "string" ? JSON.stringify(parsed) : parsed, cursor.key)
          }
        }
        cursor.continue()
      }
      const finish = () => {
        try {
          db.close()
        } catch {
          /* ignore */
        }
        resolve()
      }
      tx.oncomplete = finish
      tx.onerror = finish
      tx.onabort = finish
    })
    markDone()
  } catch {
    // Best-effort: never block app startup on a storage-repair failure.
  }
}

function markDone(): void {
  try {
    window.localStorage.setItem(DONE_FLAG, "1")
  } catch {
    /* ignore */
  }
}
