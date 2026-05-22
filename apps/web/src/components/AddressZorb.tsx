import { zorbDataURI } from "zero-deps-zorbs"

type Props = {
  address: string
  className?: string
  alt?: string
}

// Fallback avatar: a generated "zorb" for an address, shown only when there's
// no real avatar image. Unlike a real photo (which fills its slot edge to
// edge), the fallback zorb is rendered at 80% of its container and centered
// both axes, so it reads as a distinct, slightly-inset placeholder. The
// passed `className` sizes/shapes the container; the zorb scales within it.
export function AddressZorb({ address, className, alt = "" }: Props) {
  return (
    <span className={`inline-flex items-center justify-center ${className ?? ""}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={zorbDataURI(address)}
        alt={alt}
        aria-hidden={alt === "" ? true : undefined}
        className="h-[80%] w-[80%]"
        draggable={false}
      />
    </span>
  )
}
