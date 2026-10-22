# HTTP contract

All data and authentication responses use Cache-Control: no-store. Exact static assets, health and authentication endpoints are public; usage data requires a session. Unknown paths never map to a filesystem path.

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | /healthz | no | 200 {ok:true}; no paths or usage |
| GET | /api/session | optional | {authenticated:false} or {authenticated:true,csrf,mustChangePassword} |
| POST | /api/login | no; exact Origin | {passphrase:string}; 200 session, 401 failure, 429 throttle |
| POST | /api/logout | session + Origin + CSRF | expires session and cookie |
| POST | /api/password | session + Origin + CSRF | {current,newPassphrase}; rotates hash, revokes all sessions, creates a new session |
| GET | /api/report | session | sanitized collector snapshot; 503 before first scan |

CSRF is sent as X-CSRF-Token. Only application/json objects with bounded known fields are accepted. POST requests require the exact configured Origin and all non-health requests require its Host. Fetch Metadata rejects cross-site requests except a top-level GET navigation to `/` with `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`, so external links can open the public login page. Cross-site API requests, subresources and frames remain rejected. This follows the [OWASP guidance for allowing top-level navigation](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#how-to-treat-fetch-metadata-headers-on-the-server-side).

Passwords are 14–256 UTF-8 characters (maximum 1024 bytes). Login requests have a separate 4096-byte limit. API errors never echo input or internal exception messages. GET endpoints never mutate collector state. Static assets use exact MIME types. HEAD returns matching headers without a body; OPTIONS, TRACE and unsupported methods fail closed. No CORS is enabled.


The authenticated `/api/report` snapshot now optionally includes `usageEvents` (maximum 10,000). Each element contains only `at` (epoch seconds, fractional values retained), keyed pseudonymous `session` and `turn`, allowlisted model/tier/effort/role and numeric accounting metrics. Coverage adds `eventDetailsVersion`, `eventLimit`, `omittedEvents` and `eventsFrom`. No raw response IDs, text, paths or credentials are included. The web server applies a second explicit whitelist. Report size remains capped at 16 MiB. Old snapshots without event detail remain valid for date-based views and are explicitly incomplete for timestamp filters.

GET/HEAD report responses negotiate gzip and set `Vary: Accept-Encoding`; `gzip;q=0` receives plain JSON. Cache-Control remains no-store. Concurrent reads share a single bounded parse/compression; logout or password rotation during the load is rechecked before sending private bytes. CSV scope describes selected timestamps vs whole turns. No query parameters or extra data endpoints are added.
