import LandingV2Page from "./landing-v2/page"

// Keep the promoted landing dynamic: its availability and activity sections
// read live production data and must not be frozen into a deploy artifact.
export const dynamic = "force-dynamic"

export default LandingV2Page
