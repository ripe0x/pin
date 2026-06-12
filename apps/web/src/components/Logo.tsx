type LogoProps = {
  className?: string
}

/**
 * PND wordmark.
 *
 * Inlined as SVG paths (rather than an <img src="/pnd-logo.svg">) so the
 * glyph fills with `currentColor` and flips automatically between light and
 * dark themes — the paths inherit whatever text color the parent sets, and
 * the navbar sets the themed `--color-fg`. An external <img> can't read
 * `currentColor`, so it would otherwise need a brittle `dark:invert` filter.
 *
 * Source: apps/web public asset `pnd-logo.svg` (viewBox 0 0 2651 852,
 * ~3.11:1). Size it from the parent with a height utility + `w-auto`.
 */
export function Logo({ className }: LogoProps) {
  return (
    <svg
      viewBox="0 0 2651 852"
      fill="currentColor"
      role="img"
      aria-label="PND"
      className={className}
    >
      <path d="M2650.37 0V850.42H1799.96V600.3H2400.24V250.13H1799.96V0H2650.37Z" />
      <path d="M1799.96 300.328H2050.08V550.458H1799.96V300.328Z" />
      <path d="M850.41 550.901L0 550.461V300.331L600.29 300.771V250.741H0V0.621094H850.41V550.901Z" />
      <path d="M0 600.91H250.11V851.04H0V600.91Z" />
      <path d="M896.09 0H1746.51V850.42H1496.39V250.12H1146.22V850.42H896.09V0Z" />
    </svg>
  )
}
