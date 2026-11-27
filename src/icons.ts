import canvas from "./icons/canvas.png";
import chart from "./icons/chart.png";
import code from "./icons/code.png";
import document from "./icons/document.png";
import travel from "./icons/travel.png";

const icons = { canvas, chart, code, document, travel };
export const defaultIconSource = canvas;

export function iconSource(name: unknown): string | undefined {
  if (typeof name !== "string" || !Object.hasOwn(icons, name)) return;
  return icons[name as keyof typeof icons];
}
