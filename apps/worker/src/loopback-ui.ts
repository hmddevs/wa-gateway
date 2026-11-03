/**
 * Loopback control UI, Fastify on 127.0.0.1:<port>.
 *
 * Always bound to 127.0.0.1 (NEVER 0.0.0.0). No auth beyond loopback-only:
 * if someone can open a socket on 127.0.0.1 on your Mac, they already have
 * local code execution and the game is already over.
 *
 * Routes:
 *   GET  /               → HTML dashboard with session table + QR per session
 *   GET  /status         → JSON { sessions: [{ sessionId, status, phoneE164, qr? }] }
 *
 * Accessing this UI via a browser on the host machine is the ONLY way a
 * user can scan the WhatsApp pairing QR locally. The same QR is also
 * forwarded to the cloud gateway so admins can pair remotely.
 */
import Fastify from 'fastify';
import type { SessionManager } from './session-manager.js';

export async function startLoopback(
  manager: SessionManager,
  port: number,
): Promise<{ close: () => Promise<void> }> {
  const app = Fastify({ logger: false, trustProxy: false });

  app.get('/', async (_req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store');
    return html(manager);
  });

  app.get('/status', async (_req, reply) => {
    reply.header('content-type', 'application/json').header('cache-control', 'no-store');
    const sessions = manager.allSessions().map(({ sessionId, status, phoneE164, latestQr }) => ({
      sessionId,
      status,
      phoneE164,
      qr: latestQr ?? undefined,
    }));
    return { sessions };
  });

  await app.listen({ host: '127.0.0.1', port, listenTextResolver: () => '' });
  return {
    close: async () => {
      await app.close();
    },
  };
}

function statusClass(status: string): string {
  if (status === 'connected') return 'ok';
  if (status === 'pairing') return 'pairing';
  if (status === 'degraded') return 'degraded';
  return 'offline';
}

function html(manager: SessionManager): string {
  const sessions = manager.allSessions();

  const rows =
    sessions.length === 0
      ? '<tr><td colspan="4" style="color:#888">No sessions configured.</td></tr>'
      : sessions
          .map(
            ({ sessionId, status, phoneE164, latestQr }) => `
  <tr>
    <td><code>${esc(sessionId)}</code></td>
    <td class="${statusClass(status)}">${esc(status)}</td>
    <td>${phoneE164 ? esc(phoneE164) : '<span style="color:#888">not paired</span>'}</td>
    <td>${latestQr ? `<img alt="QR" width="128" height="128" src="${esc(latestQr)}" title="Scan from WhatsApp &raquo; Linked devices" />` : ''}</td>
  </tr>`,
          )
          .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>HMD WA Worker</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  body{font-family:system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 16px;color:#18181b;}
  h1{margin:0 0 16px}
  table{width:100%;border-collapse:collapse;margin-bottom:16px}
  th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #eee}
  th{background:#f4f4f5;font-weight:600}
  .ok{color:#0a0}.pairing{color:#e90}.offline{color:#c00}.degraded{color:#c60}
  img{image-rendering:pixelated}
</style>
</head>
<body>
<h1>HMD WhatsApp Worker</h1>
<table id="sessions">
  <thead>
    <tr><th>Session</th><th>Status</th><th>Phone</th><th>QR</th></tr>
  </thead>
  <tbody id="rows">${rows}</tbody>
</table>
<script>
  function cls(s){return s==='connected'?'ok':s==='pairing'?'pairing':s==='degraded'?'degraded':'offline';}
  async function tick(){
    try{
      const r=await fetch('/status',{cache:'no-store'});
      const j=await r.json();
      const tbody=document.getElementById('rows');
      if(!j.sessions||j.sessions.length===0){
        tbody.innerHTML='<tr><td colspan="4" style="color:#888">No sessions configured.</td></tr>';
        return;
      }
      tbody.innerHTML=j.sessions.map(s=>\`
        <tr>
          <td><code>\${s.sessionId}</code></td>
          <td class="\${cls(s.status)}">\${s.status}</td>
          <td>\${s.phoneE164||'<span style="color:#888">not paired</span>'}</td>
          <td>\${s.qr?'<img alt="QR" width="128" height="128" src="'+s.qr+'" />':''}</td>
        </tr>\`).join('');
    }catch(e){}
  }
  setInterval(tick,3000);tick();
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
