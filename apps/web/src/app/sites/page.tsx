import type { Metadata } from "next"
import { Hero } from "@/components/sites/Hero"
import { WhyItExists } from "@/components/sites/WhyItExists"
import { FeatureGrid } from "@/components/sites/FeatureGrid"
import { HowItWorks } from "@/components/sites/HowItWorks"
import { Faq } from "@/components/sites/Faq"
import { CallToAction } from "@/components/sites/CallToAction"

// The ScreenshotsGallery component is intentionally not imported until
// real captures land in apps/web/public/sites/ (see that directory's
// README). Showing the section with broken `<img>` tags or alt-text-only
// placeholders looked unfinished, so the section is omitted entirely
// for now. Add it back once images exist:
//   import { ScreenshotsGallery } from "@/components/sites/ScreenshotsGallery"
//   <ScreenshotsGallery /> right above <Faq />

const TITLE = "Run your own auction page"
const DESCRIPTION =
  "A self-hosted artist auction page that reads your Sovereign auction house directly from the blockchain. Free to deploy on Vercel or Netlify."

// The root layout's title.template already appends " | PND", so we pass the
// bare title here and let the template add the suffix.
export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
}

export default function SitesPage() {
  return (
    <div className="mx-auto max-w-[1400px] px-6">
      <Hero />
      <WhyItExists />
      <FeatureGrid />
      <HowItWorks />
      <Faq />
      <CallToAction />
      <div className="h-16" />
    </div>
  )
}
