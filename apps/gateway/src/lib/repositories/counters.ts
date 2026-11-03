/**
 * Atomic counter using findOneAndUpdate($inc, upsert).
 * Used for audit log sequence numbers (gap-free monotonic).
 */
import 'server-only';
import { col } from '../mongo';

interface CounterDoc {
  _id: string;
  value: number;
}

export async function nextSequence(name: string): Promise<number> {
  const c = await col<CounterDoc>('counters');
  const res = await c.findOneAndUpdate(
    { _id: name },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  if (!res || typeof res.value !== 'number') {
    throw new Error(`counters[${name}] increment failed`);
  }
  return res.value;
}
