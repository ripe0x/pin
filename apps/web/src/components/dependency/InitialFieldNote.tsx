export function InitialFieldNote() {
  return (
    <div className="border border-gray-200 rounded-md p-5 space-y-3">
      <h2 className="font-semibold">What PND means by a sovereign artist</h2>
      <p className="text-sm text-gray-600">
        Artist sovereignty starts with knowing the system around the work.
      </p>
      <p className="text-sm text-gray-600">An artist should know:</p>
      <ul className="text-sm text-gray-600 space-y-1 list-disc pl-5">
        <li>where the media lives</li>
        <li>who controls the metadata</li>
        <li>which contract handles the sale</li>
        <li>what still works if a frontend goes away</li>
      </ul>
    </div>
  )
}
