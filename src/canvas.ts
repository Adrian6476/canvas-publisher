export const MAX_HTML_BYTES = 256 * 1024;

export const canvasIdPattern = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const canvasId = new RegExp(`^${canvasIdPattern}$`, "u");
const sharePath = new RegExp(`^/c/(${canvasIdPattern})/?$`, "u");

export class CanvasError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

type Canvas = {
  id: string;
  latest_revision: number;
  published_revision: number | null;
};

type Revision = Canvas & {
  revision: number;
  title: string;
  html: string;
  presentation: string;
};

type ShareInput = {
  request_id: string;
  html: string;
  presentation: PresentationPatch;
} & (
  | { id?: undefined; base_revision?: undefined; expected_published_revision?: undefined; title: string }
  | { id: string; base_revision: number; expected_published_revision?: number | null; title?: string }
);

type PublishedDetails = { title: string; presentation: string };
type ShareReceipt = Canvas & PublishedDetails & { revision: number; share_request_hash: string };

const selectRevision = `
  SELECT c.id, c.latest_revision, c.published_revision, r.revision, r.title, r.html, r.presentation
  FROM canvases c JOIN revisions r ON r.canvas_id = c.id
`;

export class CanvasService {
  constructor(
    private readonly db: D1Database,
    readonly publicOrigin: string,
    private readonly principal: CanvasPrincipal,
  ) {}

  private id(reference: string): string {
    if (canvasId.test(reference)) return reference;
    let url: URL;
    try {
      url = new URL(reference);
    } catch {
      throw new CanvasError("INVALID_REFERENCE", "Use a canvas ID or its share URL.");
    }
    const matched = sharePath.exec(url.pathname);
    if (!matched || url.origin !== this.publicOrigin || url.username || url.password) {
      throw new CanvasError("INVALID_REFERENCE", "Use a canvas ID or its share URL.");
    }
    return matched[1];
  }

  private html(value: string): string {
    if (new TextEncoder().encode(value).byteLength > MAX_HTML_BYTES) {
      throw new CanvasError("HTML_TOO_LARGE", "HTML must be at most 256 KiB in UTF-8.");
    }
    return value;
  }

  async create(title: string, content: string, requestId: string | undefined, presentation: PresentationPatch) {
    const { ownerId, credentialId } = this.principal;
    const id = crypto.randomUUID();
    const html = this.html(content);
    const patch = JSON.stringify(presentation);
    const [insert] = await this.db.batch([
      this.db.prepare(`
        INSERT INTO canvases (id, latest_revision, owner_id, created_by, create_key) VALUES (?, 1, ?, ?, ?)
        ON CONFLICT (created_by, create_key) DO NOTHING
      `).bind(id, ownerId, credentialId, requestId ?? null),
      this.db.prepare(`
        INSERT INTO revisions (canvas_id, revision, title, html, created_by, presentation)
        SELECT id, 1, ?, ?, ?, json_patch('{}', ?) FROM canvases WHERE id = ? AND owner_id = ?
      `).bind(title, html, credentialId, patch, id, ownerId),
    ]);

    if (insert.meta.changes === 1) return { id, revision: 1 };
    const existing = await this.db.prepare(`
      ${selectRevision} WHERE c.owner_id = ? AND c.created_by = ? AND c.create_key = ?
        AND r.revision = 1 AND r.presentation = json_patch('{}', ?)
    `).bind(ownerId, credentialId, requestId ?? null, patch).first<Revision>();
    if (!existing || existing.title !== title || existing.html !== html) {
      throw new CanvasError("REQUEST_ID_REUSED", "Use a new request ID for different content.");
    }
    return { id: existing.id, revision: 1 };
  }

  async get(reference: string, revision: number | undefined) {
    const found = await this.db.prepare(`
      ${selectRevision} WHERE c.id = ? AND c.owner_id = ? AND r.revision = COALESCE(?, c.latest_revision)
    `).bind(this.id(reference), this.principal.ownerId, revision ?? null).first<Revision>();
    if (!found) throw new CanvasError("NOT_FOUND", "Canvas or revision was not found.");
    const { presentation, ...details } = found;
    return { ...details, ...parsePresentation(presentation) };
  }

  async update(reference: string, base: number, content: string, title: string | undefined, presentation: PresentationPatch) {
    const { ownerId, credentialId } = this.principal;
    const id = this.id(reference);
    const html = this.html(content);
    const [, update] = await this.db.batch([
      this.db.prepare(`
        INSERT INTO revisions (canvas_id, revision, title, html, created_by, presentation)
        SELECT c.id, c.latest_revision + 1, COALESCE(?, r.title), ?, ?, json_patch(r.presentation, ?)
        FROM canvases c
        JOIN revisions r ON r.canvas_id = c.id AND r.revision = c.latest_revision
        WHERE c.id = ? AND c.owner_id = ? AND c.latest_revision = ?
      `).bind(title ?? null, html, credentialId, JSON.stringify(presentation), id, ownerId, base),
      this.db.prepare(`
        UPDATE canvases SET latest_revision = latest_revision + 1
        WHERE id = ? AND owner_id = ? AND latest_revision = ?
      `).bind(id, ownerId, base),
    ]);

    if (update.meta.changes !== 1) {
      const current = await this.get(id, undefined);
      throw new CanvasError("REVISION_CONFLICT", `The latest draft is revision ${current.revision}. Read it before updating.`);
    }
    return { id, revision: base + 1 };
  }

  async share(input: ShareInput) {
    const { ownerId, credentialId } = this.principal;
    const { request_id, title, base_revision: base, expected_published_revision: expected } = input;
    const reference = input.id === undefined ? null : this.id(input.id);
    const id = reference ?? crypto.randomUUID();
    const html = this.html(input.html);
    const patch = JSON.stringify(input.presentation);
    const fingerprintParts = [reference, base, title, html, expected !== undefined, expected];
    // Keep existing retry receipts valid when the caller supplies no presentation fields.
    if (patch !== "{}") fingerprintParts.push(patch);
    const fingerprint = JSON.stringify(fingerprintParts);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprint));
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const hasRequest = `SELECT 1 FROM revisions WHERE created_by = ? AND share_request_id = ?`;
    const statements = base === undefined ? [
      this.db.prepare(`
        INSERT INTO canvases (id, latest_revision, published_revision, owner_id, created_by)
        SELECT ?, 1, 1, ?, ? WHERE NOT EXISTS (${hasRequest})
      `).bind(id, ownerId, credentialId, credentialId, request_id),
      this.db.prepare(`
        INSERT INTO revisions (canvas_id, revision, title, html, created_by, share_request_id, share_request_hash, presentation)
        SELECT id, 1, ?, ?, ?, ?, ?, json_patch('{}', ?) FROM canvases WHERE id = ? AND owner_id = ?
      `).bind(title, html, credentialId, request_id, hash, patch, id, ownerId),
    ] : [
      this.db.prepare(`
        INSERT INTO revisions (canvas_id, revision, title, html, created_by, share_request_id, share_request_hash, presentation)
        SELECT c.id, c.latest_revision + 1, COALESCE(?, r.title), ?, ?, ?, ?, json_patch(r.presentation, ?)
        FROM canvases c
        JOIN revisions r ON r.canvas_id = c.id AND r.revision = c.latest_revision
        WHERE c.id = ? AND c.owner_id = ? AND c.latest_revision = ?
          AND (? = 0 OR c.published_revision IS ?) AND NOT EXISTS (${hasRequest})
      `).bind(title ?? null, html, credentialId, request_id, hash, patch, id, ownerId, base,
        expected === undefined ? 0 : 1, expected ?? null, credentialId, request_id),
      this.db.prepare(`
        UPDATE canvases SET latest_revision = ?, published_revision = ?
        WHERE id = ? AND owner_id = ? AND latest_revision = ? AND EXISTS (
          SELECT 1 FROM revisions WHERE canvas_id = ? AND revision = ?
            AND created_by = ? AND share_request_id = ?
        )
      `).bind(base + 1, base + 1, id, ownerId, base, id, base + 1, credentialId, request_id),
    ];

    const [, , lookup] = await this.db.batch<ShareReceipt>([
      ...statements,
      this.db.prepare(`
        SELECT c.id, c.latest_revision, c.published_revision, r.revision, r.share_request_hash, r.title, r.presentation
        FROM revisions r JOIN canvases c ON c.id = r.canvas_id
        WHERE c.owner_id = ? AND r.created_by = ? AND r.share_request_id = ?
      `).bind(ownerId, credentialId, request_id),
    ]);
    const receipt = lookup.results[0];
    if (!receipt) {
      const current = await this.get(id, undefined);
      if (current.revision !== base) {
        throw new CanvasError("REVISION_CONFLICT", `The latest draft is revision ${current.revision}. Read it before sharing.`);
      }
      throw new CanvasError("PUBLICATION_CONFLICT", "The published version has changed. Read the canvas before sharing.");
    }
    if (receipt.share_request_hash !== hash) {
      throw new CanvasError("REQUEST_ID_REUSED", "Use a new request ID for a different share operation.");
    }
    if (receipt.published_revision !== receipt.revision) {
      throw new CanvasError("PUBLICATION_CHANGED", "This request already completed. Its revision is no longer published.");
    }
    return this.publication(receipt.id, receipt.revision, receipt);
  }

  private publication(id: string, revision: number, details: PublishedDetails) {
    return {
      id, published_revision: revision, url: `${this.publicOrigin}/c/${id}`,
      title: details.title, ...parsePresentation(details.presentation),
    };
  }

  async publish(reference: string, revision: number, expected?: number | null) {
    const id = this.id(reference);
    const owner = this.principal.ownerId;
    const [result, details] = await this.db.batch<PublishedDetails>([
      this.db.prepare(`
        UPDATE canvases SET published_revision = ?
        WHERE id = ? AND owner_id = ? AND (? = 0 OR published_revision IS ?)
          AND EXISTS (SELECT 1 FROM revisions WHERE canvas_id = canvases.id AND revision = ?)
      `).bind(revision, id, owner, expected === undefined ? 0 : 1, expected ?? null, revision),
      this.db.prepare(`
        SELECT r.title, r.presentation FROM canvases c
        JOIN revisions r ON r.canvas_id = c.id AND r.revision = c.published_revision
        WHERE c.id = ? AND c.owner_id = ?
      `).bind(id, owner),
    ]);
    if (result.meta.changes !== 1) {
      await this.get(id, revision);
      throw new CanvasError("PUBLICATION_CONFLICT", "The published version has changed. Read the canvas before publishing.");
    }
    return this.publication(id, revision, details.results[0]);
  }

  async unpublish(reference: string, expected?: number | null) {
    const id = this.id(reference);
    const result = await this.db.prepare(`
      UPDATE canvases SET published_revision = NULL
      WHERE id = ? AND owner_id = ? AND (? = 0 OR published_revision IS ?)
    `).bind(id, this.principal.ownerId, expected === undefined ? 0 : 1, expected ?? null).run();
    if (result.meta.changes !== 1) {
      await this.get(id, undefined);
      throw new CanvasError("PUBLICATION_CONFLICT", "The published version has changed. Read the canvas before unpublishing.");
    }
    return { id, published_revision: null };
  }
}
export async function readPublished(db: D1Database, id: string, includeHtml: boolean) {
  return db.prepare(`
    SELECT r.title, r.presentation, CASE WHEN ? THEN r.html END AS html
    FROM canvases c
    JOIN revisions r ON r.canvas_id = c.id AND r.revision = c.published_revision
    WHERE c.id = ?
  `).bind(includeHtml ? 1 : 0, id).first<PublishedDetails & { html: string | null }>();
}
import type { CanvasPrincipal } from "./auth";
import { parsePresentation, type PresentationPatch } from "./presentation";
