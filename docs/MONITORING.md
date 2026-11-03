# Monitoring

Guidance for monitoring your self-hosted gateway deployment.

## What to monitor

| Endpoint      | Purpose                                      |
| ------------- | -------------------------------------------- |
| `/api/health` | Gateway process liveness (no DB/Redis touch) |
| `/api/status` | Coarse WhatsApp session reachability         |

`/api/health` is the primary target: it answers in milliseconds with no upstream
dependencies, so a failure there means the gateway process or host itself is down.
`/api/status` is optional but useful to confirm the worker is connected to WhatsApp
end-to-end.

## External uptime checks

The gateway can raise its own alerts for a WhatsApp session dropping, but it cannot
alert on its own total outage (crashed process, dead host, broken DNS). Cover that gap
with an external uptime monitor that polls `/api/health` on a schedule, for example
UptimeRobot, Better Stack, or any comparable service with a free tier. Point one check
at `/api/health` and, optionally, a second at `/api/status`:

1. Create a monitor of type HTTP(S) against `https://your-domain/api/health`, polled
   every few minutes.
2. Optionally enable keyword matching on `"ok":true` in the response body, so a 200
   with a broken payload still alerts.
3. Add an alert contact (email, SMS, webhook) so you are notified on failure and on
   recovery.
4. Repeat for `/api/status` if you want visibility into the WhatsApp connection
   specifically, separate from the gateway process itself.

## Suggested thresholds

| Signal                                        | Meaning                            | Action                               |
| --------------------------------------------- | ---------------------------------- | ------------------------------------ |
| `/api/health` non-200, single check           | Transient blip or deploy in flight | Watch for recovery                   |
| `/api/health` non-200, several checks running | Gateway process or host outage     | Check host logs; redeploy            |
| `/api/status` reports WhatsApp disconnected   | Worker offline or session dropped  | Check worker logs; re-pair if needed |

## What this does not replace

Logs and application-level alerting (such as a session-disconnect notification from
the worker) remain the fastest signal for WhatsApp-layer problems, since they fire from
inside the running process. External uptime checks exist to catch the failure modes
those internal signals cannot report on themselves: the process is dead, the host is
unreachable, or DNS or certificates have broken.
