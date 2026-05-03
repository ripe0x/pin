import type { Metadata } from "next"
import { SITE_TITLE } from "@pin/shared"
import { Hero } from "@/components/sites/Hero"
import { WhyItExists } from "@/components/sites/WhyItExists"
import { FeatureGrid } from "@/components/sites/FeatureGrid"
import { HowItWorks } from "@/components/sites/HowItWorks"
import { ScreenshotsGallery } from "@/components/sites/ScreenshotsGallery"
import { Faq } from "@/components/sites/Faq"
import { CallToAction } from "@/components/sites/CallToAction"

const TITLE = "Run your own auction page"
const DESCRIPTION =
  "A self-hosted, brand-yours auction page that pulls every active and past sale from your wallet straight from the blockchain. Free to deploy on Vercel or Netlify."

export const metadata: Metadata = {
  title: `${TITLE} | ${SITE_TITLE}`,
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
      <ScreenshotsGallery />
      <Faq />
      <CallToAction />
      <div className="h-16" />
    </div>
  )
}
