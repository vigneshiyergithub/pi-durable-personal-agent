// Proof-only SSR entry (scripts/artifacts-web.ts): renders the real ArtifactsPanel against fixtures
// (or with a simulated failed request) headlessly, without a browser, the same way bench/proofs.ts
// `lab-render` renders the LabPanel. Not imported by the app; the app bundle never includes this file.
import { renderToStaticMarkup } from "react-dom/server"

import { ArtifactsPanel, type ArtifactsData } from "@/components/artifacts-panel"

export function renderArtifacts(dataJson: string, initialError?: string): string {
  const initial = dataJson === "" ? undefined : (JSON.parse(dataJson) as ArtifactsData)
  return renderToStaticMarkup(<ArtifactsPanel initial={initial} initialError={initialError} />)
}
