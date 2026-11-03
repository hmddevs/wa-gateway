'use client';
/**
 * Admin dashboard shell.
 *
 * Top bar (HMD wordmark, signed-in email, sign-out) + tabbed body
 * (Sessions / API keys / Webhooks / Security & Worker). Cross-panel concerns
 * (sessions polling, step-up state) live here; everything else is delegated
 * to the focused panel components under `_components/`.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  LogOut,
  Cable,
  Building2,
  KeyRound,
  Webhook,
  ShieldCheck,
  MessageSquare,
  BarChart2,
  ScrollText,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import {
  WebhooksPanel,
  type WebhookRouteView,
  type ApiKeyOption,
  type SessionOption,
} from './components/WebhooksPanel';
import { SessionsPanel } from './_components/SessionsPanel';
import { OrganizationsPanel } from './_components/OrganizationsPanel';
import { ApiKeysPanel } from './_components/ApiKeysPanel';
import { SecurityPanel } from './_components/SecurityPanel';
import { WorkerPanel } from './_components/WorkerPanel';
import { ConversationsLayout } from './_components/ww/ConversationsLayout';
import { MetricsPanel } from './_components/MetricsPanel';
import { AuditLogPanel } from './_components/AuditLogPanel';
import { ApiTestPanel } from './_components/ApiTestPanel';
import { WorkersManagementPanel } from './_components/WorkersManagementPanel';
import { SystemHealthPanel } from './_components/SystemHealthPanel';
import { ThemeToggle } from './_components/ThemeToggle';
import type { SessionSnapshot } from './_types';

interface AdminClientProps {
  email: string;
  workerId: string;
  hasPasskey: boolean;
  initialSessions: SessionSnapshot[];
  defaultWorkerId: string;
  initialWebhookRoutes: WebhookRouteView[];
  apiKeyOptions: ApiKeyOption[];
  sessionOptions: SessionOption[];
  signOutAction: () => Promise<void>;
  initialStepUpDone: boolean;
}

// Underline-style tab trigger, shared by every tab in the row below, // keeps the 8-way repetition down to one string instead of eight.
const TAB_TRIGGER_CLASS =
  'gap-1.5 rounded-none border-b-2 border-transparent px-3 py-2.5 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none';

export function AdminClient(props: AdminClientProps) {
  const [sessions, setSessions] = useState<SessionSnapshot[]>(props.initialSessions);
  const [passkeyRegistered, setPasskeyRegistered] = useState(props.hasPasskey);
  const [stepUpDone, setStepUpDone] = useState(props.initialStepUpDone);
  const [activeTab, setActiveTab] = useState('sessions');

  // Refresh the full session list every 6 s, preserves prior cadence.
  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/sessions', { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json()) as { sessions: SessionSnapshot[] };
        setSessions(data.sessions);
      }
    } catch {
      /* ignore transient fetch errors */
    }
  }, []);

  useEffect(() => {
    const id = setInterval(refreshSessions, 6_000);
    return () => clearInterval(id);
  }, [refreshSessions]);

  // Hoisted callback used by every panel that gates a sensitive action.
  // Navigates to the Security tab so the user can complete WebAuthn step-up
  // without manually hunting for the tab.
  const handleStepUpRequired = useCallback(() => {
    setActiveTab('security');
    import('sonner').then(({ toast }) => toast.info('Verify with passkey to send messages.'));
  }, []);

  return (
    <main className="min-h-screen bg-background text-foreground">
      {/* Top bar */}
      <header className="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-5">
          <div className="space-y-0.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">
              HMD Developments
            </p>
            <h1 className="text-lg font-semibold tracking-tight">WA Gateway Admin</h1>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="hidden font-mono text-muted-foreground sm:inline">{props.email}</span>
            <ThemeToggle />
            <form action={props.signOutAction}>
              <Button type="submit" variant="outline" size="sm">
                <LogOut />
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>

      {/* Body */}
      <div className="mx-auto max-w-6xl px-6 py-8">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-8">
          <TabsList className="h-auto w-full flex-wrap justify-start gap-1 bg-transparent p-0 border-b border-border rounded-none">
            <TabsTrigger value="sessions" className={TAB_TRIGGER_CLASS}>
              <Cable className="h-3.5 w-3.5" />
              Sessions
            </TabsTrigger>
            <TabsTrigger value="organizations" className={TAB_TRIGGER_CLASS}>
              <Building2 className="h-3.5 w-3.5" />
              Organizations
            </TabsTrigger>
            <TabsTrigger value="conversations" className={TAB_TRIGGER_CLASS}>
              <MessageSquare className="h-3.5 w-3.5" />
              Conversations
            </TabsTrigger>
            <TabsTrigger value="metrics" className={TAB_TRIGGER_CLASS}>
              <BarChart2 className="h-3.5 w-3.5" />
              Metrics &amp; System
            </TabsTrigger>
            <TabsTrigger value="keys" className={TAB_TRIGGER_CLASS}>
              <KeyRound className="h-3.5 w-3.5" />
              API keys &amp; test
            </TabsTrigger>
            <TabsTrigger value="webhooks" className={TAB_TRIGGER_CLASS}>
              <Webhook className="h-3.5 w-3.5" />
              Webhooks
            </TabsTrigger>
            <TabsTrigger value="audit" className={TAB_TRIGGER_CLASS}>
              <ScrollText className="h-3.5 w-3.5" />
              Audit
            </TabsTrigger>
            <TabsTrigger value="security" className={TAB_TRIGGER_CLASS}>
              <ShieldCheck className="h-3.5 w-3.5" />
              Security &amp; Workers
            </TabsTrigger>
          </TabsList>

          <TabsContent value="sessions" className="space-y-6">
            <SessionsPanel
              sessions={sessions}
              defaultWorkerId={props.defaultWorkerId}
              stepUpDone={stepUpDone}
              onStepUpRequired={handleStepUpRequired}
              onMutated={refreshSessions}
            />
          </TabsContent>

          <TabsContent value="organizations">
            <OrganizationsPanel
              sessions={sessions}
              stepUpDone={stepUpDone}
              onStepUpRequired={handleStepUpRequired}
              onSessionsMutated={refreshSessions}
            />
          </TabsContent>

          <TabsContent
            value="conversations"
            forceMount
            className={activeTab !== 'conversations' ? 'hidden' : undefined}
          >
            <ConversationsLayout
              sessions={sessions}
              stepUpDone={stepUpDone}
              onStepUpRequired={handleStepUpRequired}
            />
          </TabsContent>

          <TabsContent value="metrics" className="space-y-6">
            <MetricsPanel sessions={sessions} />
            <SystemHealthPanel />
          </TabsContent>

          <TabsContent value="keys" className="space-y-6">
            <ApiKeysPanel
              sessions={sessions}
              stepUpDone={stepUpDone}
              onStepUpRequired={handleStepUpRequired}
            />
            <ApiTestPanel stepUpDone={stepUpDone} onStepUpRequired={handleStepUpRequired} />
          </TabsContent>

          <TabsContent value="webhooks">
            <WebhooksPanel
              initialRoutes={props.initialWebhookRoutes}
              apiKeys={props.apiKeyOptions}
              sessions={props.sessionOptions}
              stepUpDone={stepUpDone}
              onStepUpRequired={handleStepUpRequired}
            />
          </TabsContent>

          <TabsContent value="audit">
            <AuditLogPanel />
          </TabsContent>

          <TabsContent value="security" className="space-y-6">
            <SecurityPanel
              passkeyRegistered={passkeyRegistered}
              stepUpDone={stepUpDone}
              onPasskeyRegistered={() => setPasskeyRegistered(true)}
              onStepUpVerified={() => setStepUpDone(true)}
            />
            <WorkersManagementPanel
              stepUpDone={stepUpDone}
              onStepUpRequired={handleStepUpRequired}
            />
            <WorkerPanel />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}
