export interface NavItem {
  title: string;
  href: string;
  keywords?: string[];
}

export interface NavGroup {
  group: string;
  items: NavItem[];
}

export const navTree: NavGroup[] = [
  {
    group: 'Getting started',
    items: [
      { title: 'Introduction', href: '/docs', keywords: ['overview', 'about', 'start'] },
      {
        title: 'Get an API key',
        href: '/docs/api-keys',
        keywords: ['api key', 'access', 'request', 'contact', 'getting started'],
      },
      {
        title: 'Quickstart',
        href: '/docs/quickstart',
        keywords: ['quick', 'start', 'setup', 'first message'],
      },
      {
        title: 'Authentication',
        href: '/docs/authentication',
        keywords: ['auth', 'api key', 'bearer', 'token'],
      },
      {
        title: 'Core concepts',
        href: '/docs/concepts',
        keywords: ['concepts', 'purpose', 'idempotency', 'sessions'],
      },
    ],
  },
  {
    group: 'Sending',
    items: [
      {
        title: 'Message body types',
        href: '/docs/messages',
        keywords: ['text', 'image', 'document', 'audio', 'video', 'body'],
      },
      {
        title: 'Send a message',
        href: '/docs/endpoints/send',
        keywords: ['send', 'post', 'v1 messages', 'endpoint'],
      },
      {
        title: 'Synchronous confirm',
        href: '/docs/confirm',
        keywords: ['confirm', 'sync', 'sent', 'ack'],
      },
      {
        title: 'Scheduled sends',
        href: '/docs/scheduled-sends',
        keywords: ['schedule', 'delay', 'later', 'sendAt'],
      },
      {
        title: 'Reactions',
        href: '/docs/endpoints/reactions',
        keywords: ['reaction', 'emoji', 'react'],
      },
      {
        title: 'Presence & typing',
        href: '/docs/endpoints/presence',
        keywords: ['presence', 'typing', 'online', 'composing'],
      },
    ],
  },
  {
    group: 'Reading',
    items: [
      {
        title: 'List messages',
        href: '/docs/endpoints/list',
        keywords: ['list', 'messages', 'history', 'inbox'],
      },
      {
        title: 'List groups',
        href: '/docs/endpoints/groups',
        keywords: ['groups', 'group jid', 'g.us', 'discover', 'list groups', 'whatsapp group'],
      },
      {
        title: 'Get a message',
        href: '/docs/endpoints/get',
        keywords: ['get', 'fetch', 'message', 'lookup'],
      },
      {
        title: 'Session status',
        href: '/docs/endpoints/status',
        keywords: ['status', 'connected', 'session', 'online'],
      },
      { title: 'Health', href: '/docs/endpoints/health', keywords: ['health', 'ping', 'uptime'] },
    ],
  },
  {
    group: 'Reliability',
    items: [
      {
        title: 'Rate limits',
        href: '/docs/rate-limits',
        keywords: ['rate', 'limit', 'throttle', '429'],
      },
      {
        title: 'Idempotency',
        href: '/docs/idempotency',
        keywords: ['idempotency', 'idempotent', 'duplicate', 'retry safe'],
      },
      {
        title: 'Errors',
        href: '/docs/errors',
        keywords: ['error', 'codes', '4xx', '5xx', 'fault'],
      },
      {
        title: 'Status codes',
        href: '/docs/status-codes',
        keywords: ['status', 'http', '200', '202', '4xx', '5xx', 'response'],
      },
      {
        title: 'Opt-outs',
        href: '/docs/opt-outs',
        keywords: ['opt out', 'unsubscribe', 'stop', 'contact'],
      },
      {
        title: 'Versioning',
        href: '/docs/versioning',
        keywords: ['version', 'v1', 'changelog', 'breaking'],
      },
    ],
  },
  {
    group: 'Webhooks',
    items: [
      {
        title: 'Overview',
        href: '/docs/webhooks',
        keywords: ['webhook', 'event', 'callback', 'notification'],
      },
      {
        title: 'Verifying signatures',
        href: '/docs/webhooks/verify',
        keywords: ['signature', 'hmac', 'verify', 'secret'],
      },
      {
        title: 'Event payloads',
        href: '/docs/webhooks/events',
        keywords: ['payload', 'event type', 'delivered', 'read', 'inbound'],
      },
    ],
  },
  {
    group: 'Reference',
    items: [
      {
        title: 'Conventions',
        href: '/docs/conventions',
        keywords: [
          'conventions',
          'base url',
          'timestamps',
          'phone',
          'e164',
          'encoding',
          'request id',
        ],
      },
      {
        title: 'Scopes',
        href: '/docs/scopes',
        keywords: ['scopes', 'permissions', 'send', 'read', 'access'],
      },
      {
        title: 'Headers',
        href: '/docs/headers',
        keywords: ['headers', 'authorization', 'content-type', 'x-request-id', 'cache-control'],
      },
      {
        title: 'OpenAPI spec',
        href: '/docs/openapi',
        keywords: ['openapi', 'swagger', 'spec', 'postman', 'insomnia', 'schema'],
      },
      {
        title: 'Use with AI tools',
        href: '/docs/ai-tools',
        keywords: [
          'ai',
          'llm',
          'agent',
          'llms.txt',
          'cursor',
          'copilot',
          'prompt',
          'codegen',
          'mcp',
        ],
      },
    ],
  },
  {
    group: 'Help',
    items: [
      {
        title: 'Get an API key',
        href: '/docs/api-keys',
        keywords: ['api key', 'access', 'request', 'contact'],
      },
      {
        title: 'Support',
        href: '/docs/support',
        keywords: ['support', 'help', 'contact', 'email'],
      },
    ],
  },
];

/** Flat array used for the search index. */
export interface SearchItem {
  title: string;
  href: string;
  group: string;
  keywords?: string[];
}

export const searchIndex: SearchItem[] = navTree.flatMap((group) =>
  group.items.map((item) => ({
    title: item.title,
    href: item.href,
    group: group.group,
    keywords: item.keywords,
  })),
);

/** Flat, ordered list of every doc page, drives prev/next paging. */
export const flatNav: NavItem[] = navTree.flatMap((group) => group.items);

/** Resolve the previous/next page relative to a given href. */
export function getPageNav(href: string): { prev?: NavItem; next?: NavItem } {
  const i = flatNav.findIndex((item) => item.href === href);
  if (i === -1) return {};
  return {
    prev: i > 0 ? flatNav[i - 1] : undefined,
    next: i < flatNav.length - 1 ? flatNav[i + 1] : undefined,
  };
}
