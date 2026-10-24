// Best Finds Daily — open-source newsletter system
// Magic City Endeavors / Best Finds with Greg (Birmingham, AL)
// MIT License — see LICENSE.
//
// A single Cloudflare Worker + KV namespace that provides:
//   * a public subscribe page with double opt-in confirmation
//   * token-based one-click unsubscribe
//   * a welcome message on confirmation
//   * admin-only count / CSV export / compose-send / delete endpoints
//   * a PLUGGABLE email sender (see "Sender" section below)
//
// Bindings (see wrangler.toml.example / bindings.example.json):
//   NEWS_KV      KV namespace for subscribers, tokens and the outbox
//   ADMIN_TOKEN  secret protecting /admin/* endpoints
//   SENDER       optional var: which sender to use (default "outbox")
//
// Storage layout in KV:
//   sub:<email>        JSON subscriber record
//   ctok:<token>       -> email   (confirmation token lookup)
//   utok:<token>       -> email   (unsubscribe token lookup)
//   outbox:<ts>:<id>   JSON queued message written by the stub sender

const FROM_NAME = "Best Finds Daily";
const BRAND_LINE = "Best Finds with Greg · Magic City Endeavors · Birmingham, AL";

// ---------------------------------------------------------------------------
// Sender abstraction
// ---------------------------------------------------------------------------
// Every sender implements:  async send(env, { to, subject, text, kind })
// and returns { delivered: boolean, transport: string, id?: string }.
//
// The default "outbox" sender is a STUB: it records each message in KV under
// outbox:<...> and reports delivered:false. Nothing leaves Cloudflare until a
// real provider is configured. To add one later (Resend, Brevo, Amazon SES,
// Cloudflare Email Sending, ...), implement send() with a fetch() to that
// provider's API using an API key stored as a Worker secret, register it in
// this map, and set the SENDER var to its name. No other code changes.

const senders = {
  outbox: {
    async send(env, msg) {
      const id = `${Date.now()}:${crypto.randomUUID()}`;
      await env.NEWS_KV.put(
        "outbox:" + id,
        JSON.stringify({
          to: msg.to,
          kind: msg.kind || "message",
          subject: msg.subject,
          text: msg.text,
          status: "queued",
          transport: "outbox-stub",
          created_at: new Date().toISOString(),
        })
      );
      return { delivered: false, transport: "outbox-stub", id };
    },
  },
  // resend: {
  //   async send(env, msg) {
  //     const r = await fetch("https://api.resend.com/emails", {
  //       method: "POST",
  //       headers: {
  //         "Authorization": "Bearer " + env.RESEND_API_KEY,
  //         "Content-Type": "application/json",
  //       },
  //       body: JSON.stringify({
  //         from: "Best Finds Daily <daily@yourdomain.example>",
  //         to: msg.to, subject: msg.subject, text: msg.text,
  //       }),
  //     });
  //     return { delivered: r.ok, transport: "resend" };
  //   },
  // },
};

function getSender(env) {
  return senders[env.SENDER || "outbox"] || senders.outbox;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newToken() {
  return (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
}

function normalizeEmail(raw) {
  return String(raw || "").trim().toLowerCase();
}

function validEmail(email) {
  return (
    email.length >= 3 &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
  );
}

function tokenEquals(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return tokenEquals(token, env.ADMIN_TOKEN || "");
}

async function loadSub(env, email) {
  const raw = await env.NEWS_KV.get("sub:" + email);
  return raw ? JSON.parse(raw) : null;
}

async function saveSub(env, sub) {
  await env.NEWS_KV.put("sub:" + sub.email, JSON.stringify(sub));
}

async function listKeys(env, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await env.NEWS_KV.list({ prefix, cursor, limit: 1000 });
    for (const k of page.keys) keys.push(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}

// ---------------------------------------------------------------------------
// Pages (styled to match the Best Finds hub family: paper/ink/coral,
// Barlow Condensed display type + Source Sans 3 body, hard-shadow panel)
// ---------------------------------------------------------------------------

function page(title, inner, status = 200) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="description" content="Best Finds Daily — the daily deals newsletter from Best Finds with Greg. Verified prices, honest finds, one email a day.">
<title>${title} · Best Finds Daily</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Source+Sans+3:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{color-scheme:light dark;--paper:#f4f1ea;--ink:#101416;--muted:#586166;--line:#c7c6c0;--panel:#fffdf7;--coral:#f04438;--coral-ink:#fffaf2;--gold:#f2b84b;--cyan:#38bfd1;--shadow:9px 9px 0 var(--coral);--focus:#0969da}
@media (prefers-color-scheme:dark){:root{--paper:#101416;--ink:#f4f1ea;--muted:#aeb7ba;--line:#3d4548;--panel:#191f21;--coral:#ff6257;--coral-ink:#161a1c;--gold:#efb64b;--cyan:#45c4d5;--focus:#6fbcff}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px),var(--paper);background-size:36px 36px;color:var(--ink);font-family:"Source Sans 3",sans-serif;-webkit-font-smoothing:antialiased}
.page{width:min(100%,680px);margin:0 auto;padding:clamp(24px,6vw,56px) clamp(16px,4vw,32px) 48px}
.card{background:var(--ink);color:var(--paper);border:2px solid var(--ink);box-shadow:var(--shadow);padding:clamp(24px,5vw,40px)}
.kicker{font-family:"Barlow Condensed",sans-serif;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--gold);margin:0 0 6px;font-size:15px}
h1{font-family:"Barlow Condensed",sans-serif;font-weight:800;text-transform:uppercase;line-height:.95;margin:0 0 12px;font-size:clamp(40px,9vw,62px)}
.lede{font-size:18px;line-height:1.5;margin:0 0 8px}
.panel{background:var(--panel);color:var(--ink);border:2px solid var(--ink);padding:20px;margin-top:22px}
.panel h2{font-family:"Barlow Condensed",sans-serif;text-transform:uppercase;letter-spacing:.04em;margin:0 0 8px;font-size:24px}
ul{margin:8px 0;padding-left:20px;line-height:1.55}
form{display:flex;flex-direction:column;gap:12px;margin-top:6px}
label{font-weight:600}
input[type=email]{font:inherit;padding:14px;border:2px solid var(--ink);background:var(--paper);color:var(--ink);width:100%}
button{font-family:"Barlow Condensed",sans-serif;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:20px;padding:14px 18px;background:var(--coral);color:var(--coral-ink);border:2px solid var(--ink);cursor:pointer}
button:active{transform:translate(2px,2px)}
a{color:var(--cyan)}
.small{font-size:14px;color:var(--muted);line-height:1.5}
.card .small{color:var(--muted)}
footer{margin-top:26px}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
</style>
</head>
<body>
<main class="page">${inner}</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function subscribePage() {
  return page(
    "Subscribe",
    `<div class="card">
  <p class="kicker">The daily deals briefing</p>
  <h1>Best Finds Daily</h1>
  <p class="lede">One short email a day: the best Amazon &amp; Temu finds with
  <strong>verified prices</strong>, honest notes, and links that credit the show — never spam, never fluff.</p>
  <p class="small">${BRAND_LINE}</p>
  <div class="panel">
    <h2>Get the daily finds</h2>
    <form method="post" action="/subscribe">
      <label for="email">Email address</label>
      <input id="email" type="email" name="email" required autocomplete="email" placeholder="you@example.com">
      <input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
      <input type="hidden" name="source" value="web">
      <button type="submit">Subscribe free</button>
    </form>
    <p class="small">We send a confirmation link first (double opt-in) — you are only
    subscribed once you click it. Unsubscribe any time with one click from any email.
    We may earn a commission on purchases made through links in our emails.</p>
  </div>
</div>
<footer class="small">Best Finds Daily is published by Magic City Endeavors (DBA Magic City Melting Pot), Birmingham, Alabama.</footer>`
  );
}

function messagePage(title, heading, bodyHtml, status = 200) {
  return page(
    title,
    `<div class="card">
  <p class="kicker">Best Finds Daily</p>
  <h1>${heading}</h1>
  ${bodyHtml}
</div>`,
    status
  );
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

async function handleSubscribe(request, env) {
  const form = await request.formData();
  if (form.get("website")) {
    // Honeypot tripped: pretend success, store nothing.
    return messagePage(
      "Almost there",
      "Check your inbox",
      `<p class="lede">If that address can receive mail, a confirmation link is on its way.</p>`
    );
  }
  const email = normalizeEmail(form.get("email"));
  const source = String(form.get("source") || "web").slice(0, 40);
  if (!validEmail(email)) {
    return messagePage(
      "Hmm",
      "That email looks off",
      `<p class="lede">Please go back and enter a valid email address.</p>`,
      400
    );
  }
  const origin = new URL(request.url).origin;
  let sub = await loadSub(env, email);
  const now = new Date().toISOString();

  if (sub && sub.status === "confirmed") {
    return messagePage(
      "You're in",
      "Already subscribed",
      `<p class="lede">Good news — <strong>${email}</strong> is already on the Best Finds Daily list. Watch your inbox for the next drop.</p>`
    );
  }

  if (!sub) {
    sub = {
      email,
      status: "pending",
      created_at: now,
      confirmed_at: null,
      source,
      confirm_token: newToken(),
      unsub_token: newToken(),
    };
  } else {
    // Refresh the confirmation token for a pending / unsubscribed address.
    await env.NEWS_KV.delete("ctok:" + sub.confirm_token);
    sub.status = "pending";
    sub.confirm_token = newToken();
    if (!sub.unsub_token) sub.unsub_token = newToken();
  }
  await saveSub(env, sub);
  await env.NEWS_KV.put("ctok:" + sub.confirm_token, email);
  await env.NEWS_KV.put("utok:" + sub.unsub_token, email);

  const confirmUrl = `${origin}/confirm/${sub.confirm_token}`;
  const unsubUrl = `${origin}/unsubscribe/${sub.unsub_token}`;
  await getSender(env).send(env, {
    to: email,
    kind: "confirmation",
    subject: "Confirm your Best Finds Daily subscription",
    text:
      `Welcome (almost) to Best Finds Daily — the daily finds briefing from ${BRAND_LINE}.\n\n` +
      `Confirm your subscription by opening this link:\n${confirmUrl}\n\n` +
      `If you did not request this, ignore this email and you will not be subscribed.\n` +
      `Changed your mind later? Unsubscribe any time: ${unsubUrl}\n`,
  });

  return messagePage(
    "Almost there",
    "Check your inbox",
    `<p class="lede">We sent a confirmation link to <strong>${email}</strong>.
    Click it and you're in — that's the double opt-in that keeps the list clean.</p>
    <p class="small">No email in a few minutes? Check spam/promotions, or subscribe again to get a fresh link.</p>`
  );
}

async function handleConfirm(env, token) {
  const email = await env.NEWS_KV.get("ctok:" + token);
  if (!email) {
    return messagePage(
      "Link expired",
      "That link didn't work",
      `<p class="lede">This confirmation link is invalid or was already used. Subscribe again to get a fresh one.</p>`,
      404
    );
  }
  const sub = await loadSub(env, email);
  if (!sub) {
    return messagePage("Link expired", "That link didn't work",
      `<p class="lede">We couldn't find that subscription. Subscribe again to get a fresh link.</p>`, 404);
  }
  const origin_note = "Best Finds Daily";
  if (sub.status !== "confirmed") {
    sub.status = "confirmed";
    sub.confirmed_at = new Date().toISOString();
    await saveSub(env, sub);
    await getSender(env).send(env, {
      to: email,
      kind: "welcome",
      subject: "You're in — welcome to Best Finds Daily",
      text:
        `You're confirmed. Welcome to Best Finds Daily!\n\n` +
        `Every day: the best Amazon & Temu finds with verified prices and honest notes, ` +
        `from ${BRAND_LINE}. First drop lands in your inbox soon.\n\n` +
        `— Greg Hicks, Best Finds with Greg\n`,
    });
  }
  await env.NEWS_KV.delete("ctok:" + token); // one-time use
  return messagePage(
    "Confirmed",
    "You're in!",
    `<p class="lede">Subscription confirmed for <strong>${email}</strong>. Welcome to ${origin_note} — your first daily drop is on its way soon.</p>`
  );
}

async function handleUnsubscribe(env, token) {
  const email = await env.NEWS_KV.get("utok:" + token);
  if (!email) {
    return messagePage("Unsubscribe", "Link not recognized",
      `<p class="lede">That unsubscribe link is invalid. If you keep receiving email from us, reply to it and we will remove you manually.</p>`, 404);
  }
  const sub = await loadSub(env, email);
  if (sub && sub.status !== "unsubscribed") {
    sub.status = "unsubscribed";
    sub.unsubscribed_at = new Date().toISOString();
    await saveSub(env, sub);
  }
  return messagePage(
    "Unsubscribed",
    "You've been removed",
    `<p class="lede"><strong>${email}</strong> will no longer receive Best Finds Daily. Sorry to see you go — the subscribe page is always there if you change your mind.</p>`
  );
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

async function allSubs(env) {
  const keys = await listKeys(env, "sub:");
  const subs = [];
  for (const k of keys) {
    const raw = await env.NEWS_KV.get(k);
    if (raw) subs.push(JSON.parse(raw));
  }
  subs.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  return subs;
}

async function adminCount(env) {
  const subs = await allSubs(env);
  const counts = { total: subs.length, pending: 0, confirmed: 0, unsubscribed: 0 };
  for (const s of subs) if (counts[s.status] !== undefined) counts[s.status]++;
  return Response.json(counts);
}

async function adminExport(env) {
  const subs = await allSubs(env);
  const rows = [["email", "status", "source", "created_at", "confirmed_at"]];
  for (const s of subs) {
    rows.push([s.email, s.status, s.source || "", s.created_at || "", s.confirmed_at || ""]);
  }
  const csv = rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="best-finds-daily-subscribers.csv"',
    },
  });
}

async function adminOutbox(env) {
  const keys = await listKeys(env, "outbox:");
  const msgs = [];
  for (const k of keys.slice(-50)) {
    const raw = await env.NEWS_KV.get(k);
    if (raw) msgs.push({ key: k, ...JSON.parse(raw) });
  }
  return Response.json({ count: msgs.length, messages: msgs });
}

async function adminSend(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.subject || !body.text) {
    return Response.json({ error: "JSON body with subject and text is required" }, { status: 400 });
  }
  const origin = new URL(request.url).origin;
  const subs = (await allSubs(env)).filter((s) => s.status === "confirmed");
  const sender = getSender(env);
  let queued = 0;
  for (const s of subs) {
    const text =
      body.text +
      `\n\n—\nYou are receiving Best Finds Daily because you subscribed and confirmed.\n` +
      `Unsubscribe: ${origin}/unsubscribe/${s.unsub_token}\n`;
    const r = await sender.send(env, { to: s.email, kind: "newsletter", subject: body.subject, text });
    if (r) queued++;
  }
  return Response.json({
    recipients: subs.length,
    queued,
    transport: (env.SENDER || "outbox"),
    delivered: false,
    note: "The default outbox sender is a stub: messages are recorded in KV, not delivered. Configure a real provider sender (see README) for live delivery.",
  });
}

async function adminDelete(request, env) {
  const body = await request.json().catch(() => null);
  const email = normalizeEmail(body && body.email);
  if (!validEmail(email)) {
    return Response.json({ error: "JSON body with a valid email is required" }, { status: 400 });
  }
  const sub = await loadSub(env, email);
  if (!sub) return Response.json({ deleted: false, reason: "not found" });
  await env.NEWS_KV.delete("sub:" + email);
  if (sub.confirm_token) await env.NEWS_KV.delete("ctok:" + sub.confirm_token);
  if (sub.unsub_token) await env.NEWS_KV.delete("utok:" + sub.unsub_token);
  return Response.json({ deleted: true, email });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" && request.method === "GET") return subscribePage();
    if (path === "/health" && request.method === "GET") {
      return Response.json({ ok: true, service: "best-finds-newsletter", sender: env.SENDER || "outbox" });
    }
    if (path === "/subscribe" && request.method === "POST") return handleSubscribe(request, env);

    const confirmMatch = path.match(/^\/confirm\/([a-f0-9]{32,})$/);
    if (confirmMatch && request.method === "GET") {
      return handleConfirm(env, confirmMatch[1]);
    }
    const unsubMatch = path.match(/^\/unsubscribe\/([a-f0-9]{32,})$/);
    if (unsubMatch && (request.method === "GET" || request.method === "POST")) {
      return handleUnsubscribe(env, unsubMatch[1]);
    }

    if (path.startsWith("/admin/")) {
      if (!isAdmin(request, env)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (path === "/admin/count" && request.method === "GET") return adminCount(env);
      if (path === "/admin/export.csv" && request.method === "GET") return adminExport(env);
      if (path === "/admin/outbox" && request.method === "GET") return adminOutbox(env);
      if (path === "/admin/send" && request.method === "POST") return adminSend(request, env);
      if (path === "/admin/delete" && request.method === "POST") return adminDelete(request, env);
      return Response.json({ error: "unknown admin endpoint" }, { status: 404 });
    }

    return messagePage("Not found", "Nothing here",
      `<p class="lede">That page doesn't exist. <a href="/">Back to the subscribe page</a>.</p>`, 404);
  },
};
