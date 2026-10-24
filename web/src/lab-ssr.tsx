// Proof-only SSR entry (bench/proofs.ts `lab-render`): renders the real LabPanel with the payload
// the real server served, so the panel's render code path runs headlessly, without a browser.
// Not imported by the app; the app bundle never includes this file.
import { renderToStaticMarkup } from "react-dom/server"

import { LabPanel } from "@/components/lab-panel"

export function renderLab(dataJson: string): string {
  return renderToStaticMarkup(<LabPanel initial={JSON.parse(dataJson)} />)
}
