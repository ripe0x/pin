"use client"

// Pre-launch reservation capture: a punk holder (held directly, wrapped, or
// delegated) records the id they intend to claim so it can be honored manually at
// launch. Offchain by design — no contract exists yet. Submissions POST to Netlify
// Forms (the detection form is apps/web/public/__forms.html, name
// "homage-reservation") and land in the site's Netlify Forms dashboard; holdings
// are verified there before launch. Connecting a wallet only prefills the address
// (a local useAccount read); the form itself issues no RPC.

import {useEffect, useState} from "react"
import {useAccount} from "wagmi"
import {ConnectButton} from "@rainbow-me/rainbowkit"

const FORM_NAME = "homage-reservation"

function encode(data: Record<string, string>): string {
  return Object.keys(data)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(data[k])}`)
    .join("&")
}

const INPUT =
  "w-full bg-transparent font-mono text-[12px] text-fg outline-none border-b border-gray-200 focus:border-fg py-1"
const LABEL = "text-[10px] font-mono uppercase tracking-wider text-gray-400"

export function HomageReservation() {
  const {address} = useAccount()
  const [addr, setAddr] = useState("")
  const [ids, setIds] = useState("")
  const [contact, setContact] = useState("")
  const [state, setState] = useState<"idle" | "submitting" | "done" | "error">("idle")

  // Prefill from the connected wallet once, without clobbering a manual entry.
  useEffect(() => {
    if (address) setAddr((cur) => cur || address)
  }, [address])

  const addrOk = /^0x[0-9a-fA-F]{40}$/.test(addr.trim())
  const idsOk = ids.trim().length > 0
  const canSubmit = addrOk && idsOk && state !== "submitting"

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setState("submitting")
    try {
      const res = await fetch("/__forms.html", {
        method: "POST",
        headers: {"Content-Type": "application/x-www-form-urlencoded"},
        body: encode({
          "form-name": FORM_NAME,
          address: addr.trim(),
          "punk-ids": ids.trim(),
          contact: contact.trim(),
        }),
      })
      setState(res.ok ? "done" : "error")
    } catch {
      setState("error")
    }
  }

  if (state === "done") {
    return (
      <div className="rounded-lg border border-gray-200 bg-surface p-5">
        <p className="mb-2 text-[10px] font-mono uppercase tracking-wider text-gray-400">
          Reservation recorded
        </p>
        <p className="text-[11px] font-mono leading-relaxed text-gray-500">
          Your punk ids are noted against {shorten(addr.trim())}. Holdings are verified before
          launch. You can add more from a different wallet.
        </p>
        <button
          onClick={() => {
            setIds("")
            setState("idle")
          }}
          className="mt-3 text-[10px] font-mono uppercase tracking-wider text-gray-400 underline transition-colors hover:text-fg"
        >
          Reserve another
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-gray-200 bg-surface p-5">
      <div className="space-y-1">
        <p className={LABEL}>Reserve your punk</p>
        <p className="text-[11px] font-mono leading-relaxed text-gray-500">
          Hold a punk (directly, wrapped, or delegated)? Reserve the id you plan to claim. Verified
          and honored at launch.
        </p>
      </div>

      <div className="space-y-1.5">
        <label className={LABEL} htmlFor="reserve-address">
          Your address
        </label>
        <input
          id="reserve-address"
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
          className={INPUT}
        />
        {!address && (
          <ConnectButton.Custom>
            {({openConnectModal}) => (
              <button
                type="button"
                onClick={openConnectModal}
                className="text-[10px] font-mono uppercase tracking-wider text-gray-400 underline transition-colors hover:text-fg"
              >
                or connect wallet to fill
              </button>
            )}
          </ConnectButton.Custom>
        )}
      </div>

      <div className="space-y-1.5">
        <label className={LABEL} htmlFor="reserve-ids">
          Punk id(s)
        </label>
        <input
          id="reserve-ids"
          value={ids}
          onChange={(e) => setIds(e.target.value)}
          placeholder="e.g. 3542, 7804"
          inputMode="numeric"
          className={INPUT}
        />
      </div>

      <div className="space-y-1.5">
        <label className={LABEL} htmlFor="reserve-contact">
          Contact (optional)
        </label>
        <input
          id="reserve-contact"
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          placeholder="x / farcaster / email"
          spellCheck={false}
          className={INPUT}
        />
      </div>

      <button
        type="submit"
        disabled={!canSubmit}
        className="block w-full bg-fg py-3 text-center text-[11px] font-mono font-medium uppercase tracking-wider text-bg transition-colors hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {state === "submitting" ? "Reserving…" : "Reserve"}
      </button>

      {state === "error" && (
        <p className="text-[10px] font-mono text-status-sold">
          Couldn’t record that. Try again in a moment.
        </p>
      )}
    </form>
  )
}

function shorten(a: string): string {
  return a.length >= 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
}
