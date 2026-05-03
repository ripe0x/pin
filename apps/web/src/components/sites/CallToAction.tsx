/**
 * Footer CTA. Reuses the same DeployButtons component from the hero so the
 * deploy flow is reachable at both the top and the bottom of the page,
 * without scrolling back up.
 */
import { DeployButtons, TEMPLATE_REPO_URL } from "./DeployButtons"

export function CallToAction() {
  return (
    <section className="py-16 border-t border-gray-200">
      <div className="space-y-6">
        <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight">
          Ready to host yours?
        </h2>
        <DeployButtons />
        <div className="flex flex-wrap gap-6 pt-4 text-[11px] font-mono uppercase tracking-wider text-gray-500">
          <a
            href={TEMPLATE_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-fg transition-colors"
          >
            View source ↗
          </a>
          <a
            href="/artist/0xCB43078C32423F5348Cab5885911C3B5faE217F9"
            className="hover:text-fg transition-colors"
          >
            View example ↗
          </a>
          <a
            href="https://x.com/ripe0x"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-fg transition-colors"
          >
            Contact ↗
          </a>
        </div>
      </div>
    </section>
  )
}
