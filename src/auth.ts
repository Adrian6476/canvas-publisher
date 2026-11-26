import { z } from "zod";

export type CanvasPrincipal = Readonly<{ ownerId: string; credentialId: string }>;

const identifier = z.string().regex(/^[a-z0-9_-]{1,64}$/u);
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{24,256}$/u);
const credentialsSchema = z.record(identifier, z.object({ token: tokenSchema, owner_id: identifier }).strict());
const encoder = new TextEncoder();

export async function authenticate(request: Request, credentials: string | undefined): Promise<CanvasPrincipal | undefined> {
  const supplied = /^Bearer (\S+)$/iu.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (!credentials || !supplied || !tokenSchema.safeParse(supplied).success) return;
  let config: unknown;
  try {
    config = JSON.parse(credentials);
  } catch {
    return;
  }
  const clients = credentialsSchema.safeParse(config);
  if (!clients.success) return;

  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(supplied));
  let match: CanvasPrincipal | undefined;
  let matches = 0;
  for (const [name, client] of Object.entries(clients.data)) {
    const expected = await crypto.subtle.digest("SHA-256", encoder.encode(client.token));
    if (!crypto.subtle.timingSafeEqual(digest, expected)) continue;
    matches++;
    const ownerId = client.owner_id;
    // Retain the original owner's request IDs across the ownership migration.
    match = { ownerId, credentialId: ownerId === "owner" ? name : `${ownerId}:${name}` };
  }
  if (matches === 1) return match;
}
