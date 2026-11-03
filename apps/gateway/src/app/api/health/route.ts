/**
 * Liveness + readiness health check.
 * GET /api/health → 200 with minimal shape. Never leaks internals.
 * Intentionally does NOT touch Mongo/Redis, that's /api/health/deep (M2).
 */
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  return NextResponse.json(
    {
      ok: true,
      service: 'hmd-wa-gateway',
      time: new Date().toISOString(),
    },
    { status: 200 },
  );
}
