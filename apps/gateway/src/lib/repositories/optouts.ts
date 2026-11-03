/**
 * Opt-out registry, phones that must not be messaged on a given session.
 *
 * Two ingress paths:
 *   - inbound keyword (e.g. "STOP") detected by the worker callback
 *   - admin manual addition
 *
 * The send route consults `isOptedOut` on every outbound and returns
 * `422 OPTED_OUT` when the recipient is on the list.
 */
import 'server-only';
import type { ObjectId } from 'mongodb';
import { type OptOut, OptOutSchema } from '@hmddevs/protocol';
import { col } from '../mongo';

export interface OptOutDoc extends OptOut {
  _id?: ObjectId;
}

let indexesEnsured = false;
async function ensureIndexesOnce(): Promise<void> {
  if (indexesEnsured) return;
  const c = await col<OptOutDoc>('opt_outs');
  await c.createIndexes([
    { key: { sessionId: 1, phone: 1 }, unique: true, name: 'sessionId_phone_unique' },
    { key: { sessionId: 1, createdAt: -1 }, name: 'sessionId_createdAt' },
  ]);
  indexesEnsured = true;
}

export async function isOptedOut(sessionId: string, phone: string): Promise<boolean> {
  await ensureIndexesOnce();
  const c = await col<OptOutDoc>('opt_outs');
  const hit = await c.findOne({ sessionId, phone }, { projection: { _id: 1 } });
  return hit !== null;
}

/**
 * Add an opt-out. The unique index swallows duplicates (Mongo error 11000) so
 * keyword detection on a peer that's already opted-out does not throw.
 */
export async function addOptOut(
  sessionId: string,
  phone: string,
  source: 'keyword' | 'admin',
  keyword?: string,
): Promise<void> {
  await ensureIndexesOnce();
  const doc: OptOut = OptOutSchema.parse({
    sessionId,
    phone,
    source,
    ...(keyword !== undefined ? { keyword } : {}),
    createdAt: new Date(),
  });
  const c = await col<OptOutDoc>('opt_outs');
  try {
    await c.insertOne(doc);
  } catch (err: unknown) {
    if ((err as { code?: number } | null)?.code === 11000) return; // already present
    throw err;
  }
}

export async function removeOptOut(sessionId: string, phone: string): Promise<boolean> {
  await ensureIndexesOnce();
  const c = await col<OptOutDoc>('opt_outs');
  const r = await c.deleteOne({ sessionId, phone });
  return r.deletedCount === 1;
}

export async function listOptOuts(sessionId: string): Promise<OptOut[]> {
  await ensureIndexesOnce();
  const c = await col<OptOutDoc>('opt_outs');
  return c.find({ sessionId }).sort({ createdAt: -1 }).toArray();
}
