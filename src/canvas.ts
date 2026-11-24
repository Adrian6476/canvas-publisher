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
};

const selectRevision = `
  SELECT c.id, c.latest_revision, c.published_revision, r.revision, r.title, r.html
  FROM canvases c JOIN revisions r ON r.canvas_id = c.id
`;

export class CanvasService {
  constructor(private readonly db: D1Database, private readonly publicOrigin: string) {}

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

  async create(client: string, title: string, content: string, requestId: string | undefined) {
    const id = crypto.randomUUID();
    const html = this.html(content);
    const [insert] = await this.db.batch([
      this.db.prepare(`
        INSERT INTO canvases (id, latest_revision, created_by, create_key) VALUES (?, 1, ?, ?)
        ON CONFLICT (created_by, create_key) DO NOTHING
      `).bind(id, client, requestId ?? null),
      this.db.prepare(`
        INSERT INTO revisions (canvas_id, revision, title, html, created_by)
        SELECT id, 1, ?, ?, ? FROM canvases WHERE id = ?
      `).bind(title, html, client, id),
    ]);

    if (insert.meta.changes === 1) return { id, revision: 1 };
    const existing = await this.db.prepare(`
      ${selectRevision} WHERE c.created_by = ? AND c.create_key = ? AND r.revision = 1
    `).bind(client, requestId ?? null).first<Revision>();
    if (!existing || existing.title !== title || existing.html !== html) {
      throw new CanvasError("REQUEST_ID_REUSED", "Use a new request ID for different content.");
    }
    return { id: existing.id, revision: 1 };
  }

  async get(reference: string, revision: number | undefined) {
    const found = await this.db.prepare(`
      ${selectRevision} WHERE c.id = ? AND r.revision = COALESCE(?, c.latest_revision)
    `).bind(this.id(reference), revision ?? null).first<Revision>();
    if (!found) throw new CanvasError("NOT_FOUND", "Canvas or revision was not found.");
    return found;
  }

  async update(client: string, reference: string, base: number, content: string, title?: string) {
    const id = this.id(reference);
    const html = this.html(content);
    const [, update] = await this.db.batch([
      this.db.prepare(`
        INSERT INTO revisions (canvas_id, revision, title, html, created_by)
        SELECT c.id, c.latest_revision + 1, COALESCE(?, r.title), ?, ?
        FROM canvases c
        JOIN revisions r ON r.canvas_id = c.id AND r.revision = c.latest_revision
        WHERE c.id = ? AND c.latest_revision = ?
      `).bind(title ?? null, html, client, id, base),
      this.db.prepare(`
        UPDATE canvases SET latest_revision = latest_revision + 1
        WHERE id = ? AND latest_revision = ?
      `).bind(id, base),
    ]);

    if (update.meta.changes !== 1) {
      const current = await this.get(id, undefined);
      throw new CanvasError("REVISION_CONFLICT", `The latest draft is revision ${current.revision}. Read it before updating.`);
    }
    return { id, revision: base + 1 };
  }

  async publish(reference: string, revision: number, expected?: number | null) {
    const id = this.id(reference);
    const result = await this.db.prepare(`
      UPDATE canvases SET published_revision = ?
      WHERE id = ? AND (? = 0 OR published_revision IS ?)
      AND EXISTS (SELECT 1 FROM revisions WHERE canvas_id = canvases.id AND revision = ?)
    `).bind(revision, id, expected === undefined ? 0 : 1, expected ?? null, revision).run();
    if (result.meta.changes !== 1) {
      await this.get(id, revision);
      throw new CanvasError("PUBLICATION_CONFLICT", "The published version has changed. Read the canvas before publishing.");
    }
    return { id, published_revision: revision, url: `${this.publicOrigin}/c/${id}` };
  }

  async unpublish(reference: string, expected?: number | null) {
    const id = this.id(reference);
    const result = await this.db.prepare(`
      UPDATE canvases SET published_revision = NULL
      WHERE id = ? AND (? = 0 OR published_revision IS ?)
    `).bind(id, expected === undefined ? 0 : 1, expected ?? null).run();
    if (result.meta.changes !== 1) {
      await this.get(id, undefined);
      throw new CanvasError("PUBLICATION_CONFLICT", "The published version has changed. Read the canvas before unpublishing.");
    }
    return { id, published_revision: null };
  }

  async readPublished(id: string, field: "title" | "html") {
    const row = await this.db.prepare(`
      SELECT r.${field} AS value
      FROM canvases c
      JOIN revisions r ON r.canvas_id = c.id AND r.revision = c.published_revision
      WHERE c.id = ?
    `).bind(id).first<{ value: string }>();
    return row?.value ?? null;
  }
}
