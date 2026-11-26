import { z } from "zod";

export const faviconIds = ["canvas", "document", "chart", "travel", "code"] as const;
export const layouts = ["compact", "feature", "editorial"] as const;
export const accents = ["neutral", "blue", "teal", "violet", "amber"] as const;

const summary = z.string().trim().min(1).max(180)
  .describe("One sentence in the user's language explaining what the reader will get. Omit if the title already says enough.");
const favicon = z.enum(faviconIds)
  .describe("Browser tab icon. Choose the closest subject. The default is canvas.");
const card = z.strictObject({
  layout: z.enum(layouts).describe("Use compact for a simple deliverable, feature for an overview with key facts, or editorial for a reading-oriented report.").optional(),
  accent: z.enum(accents).describe("Choose a single color suited to the content.").optional(),
  highlights: z.array(z.string().trim().min(1).max(80)).max(3)
    .describe("Up to three short, concrete facts or deliverables. Prefer checkable details and avoid repeating the title or summary.").optional(),
  action_label: z.string().trim().min(1).max(24)
    .describe("Optional clear verb and object for opening the canvas, such as View itinerary.").optional(),
});

export const presentationOutput = {
  summary: summary.optional(),
  favicon: favicon.optional(),
  card: card.optional(),
};

export const presentationInput = {
  summary: summary.nullish().describe("One useful sentence about what the reader will get. Omit to inherit on edit, or send null to remove."),
  favicon: favicon.nullish().describe("Browser tab icon chosen for the subject. Omit to inherit on edit, or send null for the Canvas default."),
  card: z.strictObject({
    layout: card.shape.layout.nullable(),
    accent: card.shape.accent.nullable(),
    highlights: card.shape.highlights.nullable(),
    action_label: card.shape.action_label.nullable(),
  }).nullish().describe("Optional card design. On edits, omitted options inherit and null resets an option or the whole card."),
};

const presentationSchema = z.object(presentationOutput);
const presentationPatchSchema = z.object(presentationInput);
export type Presentation = z.infer<typeof presentationSchema>;
export type PresentationPatch = z.infer<typeof presentationPatchSchema>;

export function parsePresentation(json: string): Presentation {
  return presentationSchema.parse(JSON.parse(json));
}
