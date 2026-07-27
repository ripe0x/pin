import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { SeededDeployWizard } from "@/components/launch/SeededDeployWizard"
import { getLaunchDescriptor } from "@/lib/launch-descriptors"

/**
 * The seeded, reviewed deploy page for a specific launch (see
 * docs/pnd-surface-second-launch.md "Deploy page"). Not indexed — this is
 * a private link shared with the artist, not a discovery surface.
 */

type Params = Promise<{ slug: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params
  const descriptor = getLaunchDescriptor(slug)
  return {
    title: descriptor ? `Deploy — ${descriptor.name}` : "Deploy",
    robots: { index: false, follow: false },
  }
}

export default async function LaunchDeployPage({ params }: { params: Params }) {
  const { slug } = await params
  const descriptor = getLaunchDescriptor(slug)
  if (!descriptor) notFound()

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-6 py-12">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight">Deploy: {descriptor.name}</h1>
        <p className="text-sm text-gray-500 leading-relaxed">
          Every field below is pre-filled and editable. You connect your own wallet,
          you sign the deploy transaction, and you own the resulting contract
          outright.
        </p>
      </header>
      <SeededDeployWizard descriptor={descriptor} />
    </div>
  )
}
