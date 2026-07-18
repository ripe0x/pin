import type { Metadata } from "next"
import Image from "next/image"

export const metadata: Metadata = {
  title: "World. Computer. Cap — Ethereum Objects",
  description:
    "World. Computer. Hand-lettered white embroidery on a black cotton cap.",
  openGraph: {
    title: "World. Computer. Cap — Ethereum Objects",
    description:
      "World. Computer. Hand-lettered white embroidery on a black cotton cap.",
    type: "website",
    images: ["/objects/cap-front.jpg"],
  },
  twitter: {
    card: "summary_large_image",
    title: "World. Computer. Cap — Ethereum Objects",
    description:
      "World. Computer. Hand-lettered white embroidery on a black cotton cap.",
    images: ["/objects/cap-front.jpg"],
  },
}

const gallery = [
  {
    src: "/objects/cap-front.jpg",
    alt: "World. Computer. cap — front view, hand-lettered white embroidery on black",
    priority: true,
  },
  {
    src: "/objects/cap-right.jpg",
    alt: "World. Computer. cap — right side view",
    priority: false,
  },
  {
    src: "/objects/cap-left.jpg",
    alt: "World. Computer. cap — left side view",
    priority: false,
  },
  {
    src: "/objects/cap-back.jpg",
    alt: "World. Computer. cap — back view, adjustable strap",
    priority: false,
  },
]

export default function ObjectsPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-8 md:gap-12">
        <div className="grid grid-cols-2 gap-2 self-start">
          {gallery.map((img) => (
            <div
              key={img.src}
              className="relative aspect-square w-full bg-gray-100 overflow-hidden"
            >
              <Image
                src={img.src}
                alt={img.alt}
                fill
                sizes="(max-width: 768px) 50vw, 33vw"
                priority={img.priority}
                className="object-cover"
              />
            </div>
          ))}
        </div>

        <div className="md:sticky md:top-12 self-start max-w-[480px] space-y-8">
          <div>
            <h1 className="text-[28px] font-semibold tracking-tight leading-tight">
              World. Computer. Cap
            </h1>
            <p className="font-mono text-sm mt-3">$42.00</p>
          </div>

          <a
            href="https://s04ntj-uh.myshopify.com/cart/41768021459077:1"
            className="block w-full text-center bg-fg text-bg font-mono text-[11px] font-medium uppercase tracking-wider py-3.5 px-4 hover:opacity-80 transition-opacity"
          >
            Buy
          </a>

          <p className="text-base leading-relaxed">
            A black cotton twill dad cap. Six panels, unstructured,
            low-profile. Adjustable strap, one size.
          </p>

          <p className="font-mono text-xs text-fg-subtle">
            Made to order. Ships from the US, flat $6.50. All sales final.
          </p>
        </div>
      </div>
    </div>
  )
}
