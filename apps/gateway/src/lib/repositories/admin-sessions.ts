/**
 * Admin session repository. Short-lived (8h), IP-pinned, __Host- cookies.
 * The browser holds the opaque session id; this is the server side of it.
 */
import 'server-only';
import type { ObjectId } from 'mongodb';
import { col } from '../mongo';

export interface AdminSessionDoc {
  _id?: ObjectId;
  sessionId: string; // base64url(32)
  email: string;
  ip: string;
  userAgent: string;
  createdAt: Date;
  expiresAt: Date;
  webauthnVerifiedAt?: Date | null;
}

export async function insertSession(doc: AdminSessionDoc): Promise<void> {
  const c = await col<AdminSessionDoc>('admin_sessions');
  await c.insertOne(doc);
}

export async function findSession(sessionId: string): Promise<AdminSessionDoc | null> {
  const c = await col<AdminSessionDoc>('admin_sessions');
  return c.findOne({ sessionId });
}

export async function markWebauthn(sessionId: string): Promise<void> {
  const c = await col<AdminSessionDoc>('admin_sessions');
  await c.updateOne({ sessionId }, { $set: { webauthnVerifiedAt: new Date() } });
}

export async function destroySession(sessionId: string): Promise<void> {
  const c = await col<AdminSessionDoc>('admin_sessions');
  await c.deleteOne({ sessionId });
}
