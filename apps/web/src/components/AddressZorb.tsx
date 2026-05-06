import { zorbDataURI } from "zero-deps-zorbs"

type Props = {
  address: string
  className?: string
  alt?: string
}

export function AddressZorb({ address, className, alt = "" }: Props) {
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={zorbDataURI(address)}
      alt={alt}
      aria-hidden={alt === "" ? true : undefined}
      className={className}
      draggable={false}
    />
  )
}
