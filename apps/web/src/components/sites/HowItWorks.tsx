/**
 * Three-step horizontal block. Big numbers in mono, brief copy underneath.
 * Stacks vertically on mobile, three columns on desktop.
 */
const steps = [
  {
    number: "01",
    title: "Click Deploy",
    body: "Pick Vercel or Netlify. You'll be walked through GitHub sign-in.",
  },
  {
    number: "02",
    title: "Paste your wallet address",
    body: "One field. That's the only setting required to ship.",
  },
  {
    number: "03",
    title: "Done.",
    body: "Your page is live at a *.vercel.app or *.netlify.app URL in about two minutes. Add a custom domain whenever you're ready.",
  },
]

export function HowItWorks() {
  return (
    <section className="py-16 border-t border-gray-200">
      <div className="space-y-12">
        <div>
          <p className="text-[11px] font-mono uppercase tracking-wider text-gray-500">
            How it works
          </p>
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight mt-2">
            Two minutes from click to live.
          </h2>
        </div>
        <ol className="grid grid-cols-1 md:grid-cols-3 gap-px bg-gray-200 border border-gray-200">
          {steps.map((s) => (
            <li key={s.number} className="bg-bg p-8 space-y-3">
              <p className="text-2xl font-mono font-medium tabular-nums text-gray-400 leading-none">
                {s.number}
              </p>
              <h3 className="text-lg font-semibold tracking-tight">
                {s.title}
              </h3>
              <p className="text-sm text-fg-muted leading-relaxed">{s.body}</p>
            </li>
          ))}
        </ol>
        <p className="text-sm text-gray-500 max-w-prose">
          Optional: paste a free Alchemy RPC URL during setup to make pages
          load even faster. You can do this any time.
        </p>
      </div>
    </section>
  )
}
