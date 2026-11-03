import { redirect } from 'next/navigation';
import { auth, signOut } from '@/lib/auth';
import { adminEmailAllowlist } from '@/lib/env';
import { listByEmail } from '@/lib/repositories/webauthn';
import { listSessions } from '@/lib/repositories/sessions';
import { listKeys } from '@/lib/repositories/api-keys';
import { listRoutes, type WebhookRouteDoc } from '@/lib/repositories/webhook-routes';
import { env } from '@/lib/env';
import { cookies } from 'next/headers';
import { findSession } from '@/lib/repositories/admin-sessions';
import { AdminClient } from './AdminClient';
import type { WebhookRouteView } from './components/WebhooksPanel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function stripRoute(doc: WebhookRouteDoc): WebhookRouteView {
  return {
    routeId: doc.routeId,
    scope: doc.scope,
    url: doc.url,
    // WebhookEventType is a string union, the cast is safe; the DB only stores
    // values that satisfy that union (enforced at write time by the repository).
    events: doc.events as WebhookRouteView['events'],
    active: doc.active,
    description: doc.description,
    secretFingerprint: doc.secretFingerprint,
    // Serialise Dates to ISO strings, Next.js cannot pass Date across the boundary.
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt),
    createdBy: doc.createdBy,
    lastDeliveryAt:
      doc.lastDeliveryAt instanceof Date
        ? doc.lastDeliveryAt.toISOString()
        : doc.lastDeliveryAt
          ? String(doc.lastDeliveryAt)
          : null,
    lastDeliveryStatus: doc.lastDeliveryStatus,
    lastDeliveryHttpStatus: doc.lastDeliveryHttpStatus,
    revokedAt:
      doc.revokedAt instanceof Date
        ? doc.revokedAt.toISOString()
        : doc.revokedAt
          ? String(doc.revokedAt)
          : null,
  };
}

export default async function AdminPage() {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email) redirect('/admin/login');
  if (!adminEmailAllowlist().includes(email)) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <div className="max-w-sm space-y-2 text-center">
          <h1 className="text-lg font-semibold tracking-tight">Forbidden</h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{email}</span> is not on the admin allowlist.
          </p>
        </div>
      </main>
    );
  }

  async function signOutAction() {
    'use server';
    await signOut({ redirectTo: '/admin/login' });
  }

  const [creds, sessions, keys, routes] = await Promise.all([
    listByEmail(email),
    listSessions(),
    listKeys(),
    listRoutes({ includeRevoked: false }),
  ]);

  // Serialise MongoDB Dates to ISO strings so the client component receives
  // plain JSON-safe values (Next.js cannot serialise Date across the
  // server/client boundary).
  const serialisedSessions = JSON.parse(JSON.stringify(sessions));

  const apiKeyOptions = keys
    .filter((k) => !k.revokedAt)
    .map((k) => ({ keyId: k.keyId, label: k.label, sessionId: k.sessionId }));

  const sessionOptions = sessions.map((s) => ({
    sessionId: s.sessionId,
    label: s.label,
  }));

  const webhookRoutes = routes.map(stripRoute);

  // Detect a recent WebAuthn step-up so the client shell can start unlocked
  // without waiting for a manual re-verify (e.g. on page refresh after step-up).
  const STEP_UP_MAX_AGE_MS = 5 * 60 * 1_000;
  const cookieStore = await cookies();
  const adminSessionId = cookieStore.get('__Host-hmd-admin')?.value ?? null;
  let initialStepUpDone = false;
  if (adminSessionId) {
    const adminSess = await findSession(adminSessionId);
    if (adminSess?.webauthnVerifiedAt) {
      initialStepUpDone = Date.now() - adminSess.webauthnVerifiedAt.getTime() <= STEP_UP_MAX_AGE_MS;
    }
  }

  return (
    <AdminClient
      email={email}
      workerId={env.WORKER_ID}
      hasPasskey={creds.length > 0}
      initialSessions={serialisedSessions}
      defaultWorkerId={env.WORKER_ID}
      initialWebhookRoutes={webhookRoutes}
      apiKeyOptions={apiKeyOptions}
      sessionOptions={sessionOptions}
      signOutAction={signOutAction}
      initialStepUpDone={initialStepUpDone}
    />
  );
}
