export function InitialFieldNote() {
  return (
    <div className="border border-gray-200 rounded-md p-5 space-y-3">
      <h2 className="font-semibold">Understand the systems around the work</h2>
      <p className="text-sm text-gray-600">
        Onchain work can live across contracts, metadata, media, sale
        systems, and public context. PND is trying to make those layers
        easier for artists to see and understand.
      </p>
      <p className="text-sm text-gray-600">This report shows:</p>
      <ul className="text-sm text-gray-600 space-y-1 list-disc pl-5">
        <li>where the work lives</li>
        <li>which contracts it sits on</li>
        <li>which parts appear artist-controlled</li>
        <li>which parts may depend on outside systems</li>
        <li>what still needs a closer look</li>
      </ul>
    </div>
  )
}
