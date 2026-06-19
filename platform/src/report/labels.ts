/**
 * Presentation-only display labels for criterion ids (D27-adjacent: display metadata, never
 * verdict logic). Friendly headings for the demo's criteria, with a fallback to the raw id so
 * the renderers stay generic — an unknown criterion still renders by its stable id. The id
 * itself is always shown as smaller secondary text, so nothing is hidden.
 */

export const CRITERION_LABELS: Record<string, string> = {
  "add-to-cart:C1": "Line totals",
  "add-to-cart:C2": "Proportional tax",
  "add-to-cart:C3": "Total reconciliation",
};

export function criterionLabel(id: string): string {
  return CRITERION_LABELS[id] ?? id;
}
