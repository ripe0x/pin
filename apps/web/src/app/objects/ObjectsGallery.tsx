"use client"

import Image from "next/image"
import { useCallback, useEffect, useState } from "react"

export type GalleryImage = {
  src: string
  alt: string
  priority?: boolean
}

export function ObjectsGallery({ images }: { images: GalleryImage[] }) {
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const [zoomed, setZoomed] = useState(false)

  const show = useCallback((i: number) => {
    setIndex(i)
    setZoomed(false)
    setOpen(true)
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    setZoomed(false)
  }, [])

  const next = useCallback(() => {
    setZoomed(false)
    setIndex((i) => (i + 1) % images.length)
  }, [images.length])

  const prev = useCallback(() => {
    setZoomed(false)
    setIndex((i) => (i - 1 + images.length) % images.length)
  }, [images.length])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close()
      else if (e.key === "ArrowRight") next()
      else if (e.key === "ArrowLeft") prev()
    }
    window.addEventListener("keydown", onKey)
    // lock scroll while the lightbox is open
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, close, next, prev])

  return (
    <>
      <div className="grid grid-cols-2 gap-2 self-start">
        {images.map((img, i) => (
          <button
            key={img.src}
            type="button"
            onClick={() => show(i)}
            aria-label={`Zoom ${img.alt}`}
            className="relative aspect-square w-full bg-gray-100 overflow-hidden cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-fg"
          >
            <Image
              src={img.src}
              alt={img.alt}
              fill
              sizes="(max-width: 768px) 50vw, 33vw"
              priority={img.priority}
              className="object-cover"
            />
          </button>
        ))}
      </div>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Product image viewer"
          className="fixed inset-0 z-50 flex items-center justify-center bg-bg"
          onClick={close}
        >
          {/* close */}
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="absolute top-4 right-4 z-10 font-mono text-[11px] uppercase tracking-wider text-fg-subtle hover:text-fg transition-colors p-2"
          >
            Close
          </button>

          {/* counter */}
          <span className="absolute top-4 left-1/2 -translate-x-1/2 font-mono text-[11px] tracking-wider text-fg-subtle">
            {index + 1} / {images.length}
          </span>

          {/* prev */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              prev()
            }}
            aria-label="Previous image"
            className="absolute left-2 md:left-6 z-10 font-mono text-2xl text-fg-subtle hover:text-fg transition-colors p-4 select-none"
          >
            &larr;
          </button>

          {/* image */}
          <div
            className={`relative mx-16 my-16 flex items-center justify-center ${
              zoomed ? "cursor-zoom-out" : "cursor-zoom-in"
            }`}
            onClick={(e) => {
              e.stopPropagation()
              setZoomed((z) => !z)
            }}
          >
            <Image
              key={images[index].src}
              src={images[index].src}
              alt={images[index].alt}
              width={1000}
              height={1000}
              sizes="100vw"
              priority
              className={`select-none transition-transform duration-200 ${
                zoomed
                  ? "scale-150 md:scale-[1.75]"
                  : "max-h-[80vh] w-auto object-contain"
              }`}
            />
          </div>

          {/* next */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              next()
            }}
            aria-label="Next image"
            className="absolute right-2 md:right-6 z-10 font-mono text-2xl text-fg-subtle hover:text-fg transition-colors p-4 select-none"
          >
            &rarr;
          </button>
        </div>
      )}
    </>
  )
}
