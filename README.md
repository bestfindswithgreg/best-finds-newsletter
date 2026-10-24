# Best Finds Daily — Open-Source Newsletter System

A small, self-hosted newsletter system that runs entirely on **Cloudflare
Workers + KV** — no SaaS newsletter platform, no monthly bill, no vendor
lock-in. Built for **Best Finds Daily**, the daily deals briefing from
*Best Finds with Greg* (Magic City Endeavors, Birmingham, AL), after the
previous platform's trial ended. MIT licensed; reuse it for your own list.

**Live subscribe page:** https://best-finds-newsletter.themagiccitymeltingpot.workers.dev/

## What it does

- **Public subscribe page** — mobile-first, styled to match the Best Finds hub
  family, with a honeypot field for bots.
- **Double opt-in** — subscribing creates a *pending* record and emails a
  confirmation link; the address only becomes a subscriber after clicking it.
  Confirmation tokens are one-time use.
- **Welcome message** — queued/sent automatically on confirmation.
- **One-click unsubscribe** — every subscriber gets a permanent token link;
  works over GET (browser) and POST (mail-client one-click, RFC 8058 style).
- **Admin endpoints** (Bearer-token protected) — subscriber counts, full CSV
  export, recent outbox, compose/send to confirmed subscribers, and delete.
- **Pluggable sender** — all mail goes through one `senders` map in
  `worker.js`. Swap providers without touching the flows.

## Honest limitation: sending

The default sender, `outbox`, is a **stub**. It records every message
(confirmation, welcome, newsletter) as JSON in KV under `outbox:<...>` and
reports `delivered: false`. **No email actually leaves Cloudflare yet**,
because this account has no free outbound email route configured. Capture,
confirmation mechanics, unsubscribe, export and the send pipeline are fully
working — only the last-mile transport is stubbed.

To go live, implement one entry in the `senders` map in `worker.js` (a
commented Resend example is included), store the provider API key as a Worker
secret, and set the `SENDER` variable to its name. Resend, Brevo and Amazon
SES all have free/cheap tiers; Cloudflare Email Sending is another option
when available on the account. Nothing else changes.

## Architecture

```
Browser ──► Worker (worker.js) ──► KV namespace (NEWS_KV)
              │  routes: /, /subscribe, /confirm/<token>,
              │          /unsubscribe/<token>, /admin/*, /health
              └──► senders[SENDER].send() ──► outbox stub (KV)
                                          └► future: provider API
```

### KV storage layout

| Key                 | Value |
|---------------------|-------|
| `sub:<email>`       | JSON: `email, status (pending/confirmed/unsubscribed), created_at, confirmed_at, unsubscribed_at, source, confirm_token, unsub_token` |
| `ctok:<token>`      | email (confirmation lookup; deleted on use) |
| `utok:<token>`      | email (unsubscribe lookup; permanent) |
| `outbox:<ts>:<id>`  | JSON queued message written by the stub sender |

Storage is KV because the account's API token has no D1 permission (D1 list
returned 401). If you have D1, the same record shape maps 1:1 onto a
`subscribers` table.

### Known quirk

Cloudflare KV is eventually consistent (reads/lists can lag writes by up to
~60 s). Consequences: admin counts may briefly lag a signup, and clicking a
confirmation link twice in rapid succession can queue a duplicate welcome
message. Both are harmless for a newsletter of this size.

## Setup

1. Create a KV namespace named `best-finds-newsletter`.
2. Deploy `worker.js` as a Worker (wrangler, the dashboard, or the
   Cloudflare API) with the bindings in `bindings.example.json`
   (`wrangler.toml.example` for wrangler users).
3. Set the admin secret — never commit it:
   `wrangler secret put ADMIN_TOKEN` (or the API's secrets endpoint).
4. Enable the Worker's `workers.dev` subdomain (or attach a custom domain).
5. Test: open `/`, subscribe with your own address, read the queued
   confirmation from `GET /admin/outbox` (while the stub sender is active),
   open its `/confirm/<token>` link, then check `GET /admin/count`.

## Admin API

All admin calls need `Authorization: Bearer <ADMIN_TOKEN>`.

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<worker>/admin/count
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<worker>/admin/export.csv
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<worker>/admin/outbox
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"subject":"Today\u2019s finds","text":"..."}' https://<worker>/admin/send
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"email":"person@example.com"}' https://<worker>/admin/delete
```

## License

MIT — see [LICENSE](LICENSE). Original code; no proprietary code copied.
