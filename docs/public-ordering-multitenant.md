# Multi-tenant public ordering

Status: **PHASE 1 IMPLEMENTED IN THE CLIENT** — phases 2 and 3 are design only.

Phase 1 decided 2026-09-26: portal read-only first. What is built in this repository is listed
under [Phase 1, as built](#phase-1-as-built); the hosted server and portal themselves live outside
it.

Today [guest-ordering.md](guest-ordering.md) describes one shop: `main/guest-server.ts` on port
3004, one SQLite file, tokens unique inside that file, published (if at all) through a tunnel the
merchant runs themselves. This document designs the hosted version: **one public server serving many
shops**, where the shop owner signs in to a portal with the same email as their POS owner account,
configures customer ordering there, and has it sync with their POS machine.

It builds on cloud coordination that already exists — `main/services/cloud-sync.ts`, the FloAdmin
store identity (`store_id`, `pos_hash`, `api_key`) and the outbound relay — rather than inventing a
second cloud. See [cloud-v2-plan.md](cloud-v2-plan.md) for that groundwork.

---

## The part to get right first: email is not proof

The request was "log in with the same email as the POS admin and you get in". Taken literally that
is an account-takeover primitive, so this design does **not** do it.

A merchant's owner email is printed on receipts, sits on their invoices, their Facebook page and
their Google listing. It is a *public identifier*, not a secret. If matching it were sufficient,
anyone who reads a receipt could register on the portal, claim the shop, and from there read the
menu and order feed and (once portal writes exist) change prices or switch ordering on.

**Linking a portal account to a store requires two independent proofs, both at once:**

| Proof | What it establishes | How |
|---|---|---|
| 1. Mailbox control | The person can receive mail at that address | Federated sign-in (Google/Apple/Microsoft), or a magic link |
| 2. POS machine control | The person is physically at, or trusted by, the shop | One-time code shown **on the POS screen**, owner/manager only, short-lived, single use |

The email is what *points at* the right store. The pairing code is what *authorises* the link. After
the link exists it is recorded server-side, and later sign-ins need only proof 1 — the account is
already bound to that store.

Corollaries:

- Changing the owner email on the POS does not move the link. Links are to a portal account id, not
  to an email string.
- A portal account and a POS staff account stay **separate objects**. The portal never stores POS
  password hashes, never creates POS staff accounts, and pairing never transfers a password.
- Unlinking is available from both ends: the portal, and the POS machine. Either side can cut it.

The mechanism already half-exists: `getCachedPairingCode()` / `setCachedPairingCode()` in
`main/db.ts` and `POST /api/pos/pairing-code` in `main/services/cloud-sync.ts` issue exactly this
kind of short-lived single-use code for RevFlo device pairing. Portal linking reuses it.

### On OmniAuth

OmniAuth itself is Ruby/Rack and FloAdmin is PHP, so the gem is not usable — but the pattern is the
right one, and the security benefit is real: delegate identity to Google/Apple/Microsoft and the
portal holds **no passwords at all**. No password storage, no reset flow, no credential stuffing,
and MFA comes from the identity provider for free. For a multi-tenant control plane that is the
single biggest reduction in attack surface available. PHP equivalent: `league/oauth2-client`, or a
hosted identity provider.

Recommended: Google + Apple sign-in only, no local portal passwords.

---

## Shape

```
  Customer phone ──── HTTPS ────> Flo Order          (public, multi-tenant, VPS)
  Owner browser  ──── HTTPS ────> Flo Order portal          │
                                                            │
                                     connection is dialled OUT by the POS,
                                     held open, never inbound
                                                            │
                                                            v
                                                   POS machine (Electron, behind NAT)
```

The POS never accepts an inbound connection. It dials out and keeps a WSS relay open, exactly as
`connectRelay()` does today against `/api/pos/relay`, authenticated with HMAC-signed headers
(`buildSignedHeaders`: method, path, timestamp, nonce, body hash, signed with `api_key`). Nothing
about the shop's firewall changes, and the "never publish 3001/3002/3003" rule is untouched — in the
hosted model the merchant publishes *nothing*.

The local LAN server on 3004 keeps working unchanged and keeps working with the internet down. The
hosted service is an addition, never a replacement: a shop that loses its uplink must still be able
to take orders on its own WiFi.

---

## Tenancy

**Tenant = store**, keyed by the existing FloAdmin `store_id`. One store may have several POS
machines (`pos_hash`); the relay connection identifies which.

### QR tokens must carry their tenant

A `guest_token` today is 32 random base64url characters, unique within one shop's SQLite file. On a
shared server that guarantee is gone. Token format becomes:

```
<store_ref>.<secret>
       │        └── the existing 32-char base64url secret, unchanged
       └── short opaque public store reference — not the shop name, not sequential
```

Resolution is then a single indexed lookup: split on `.`, find the tenant by `store_ref`, then the
table by the whole token within that tenant. Two shops can never collide, and no global cross-tenant
scan is needed.

The local server accepts a bare secret with no prefix, so existing printed codes keep working on the
LAN and the format change is additive.

*Alternative considered:* one global token table with a unique index across all tenants. Rejected —
it works, but it makes the tenant a property discovered *after* the lookup rather than before, which
is the wrong order for the isolation rules below, and it resists sharding later.

The reference is issued by the cloud at registration (`store_ref` in the `/api/pos/register`
response, stored as `cloud_store_ref`). Until one exists, tokens stay bare and everything behaves
exactly as it does today.

**Re-registering into a different store reference retires prefixed printouts.** That is deliberate —
the alternative is accepting a prefix that no longer describes this shop — but it means a reprint,
so it should not be a routine operation.

### Table codes go to the cloud as hashes

The hosted server has to turn a scan into a table, but it never needs the token itself to do it: the
phone sends the token, the server hashes it and looks the hash up. So what leaves the POS is
`sha256(<store_ref>.<secret>)` and never the secret. A breach of the hosted database yields hashes,
and a 192-bit random secret is not recoverable from one — the stickers on the tables stay good.

### Isolation rules

These are the rules that a multi-tenant bug would break, so they are stated as rules and not left to
be inferred:

1. **`tenant_id` is never read from the request.** Not from a path parameter, not from a header, not
   from a body field. It comes from the resolved token, or from the server-side portal session.
2. **The portal session holds the tenant server-side.** A store switcher re-issues the session; it
   never accepts a store id the browser sends.
3. **One relay connection = one `pos_hash` = one tenant.** Every frame arriving on it is stamped
   with that tenant server-side. A frame that claims a different `store_id` is dropped and logged as
   an attack, not reconciled.
4. **Per-tenant storage prefixes** for product images and any upload. No shared filename namespace.
5. **Rate limits are per tenant as well as per IP**, so one busy shop cannot starve another, and one
   abusive IP cannot lock out a whole shop.

---

## What syncs, and which way

| Data | Direction | Trigger |
|---|---|---|
| Menu: name, price, description, category, image, active flag | POS → cloud | change, via the existing outbox |
| Tables and their guest tokens | POS → cloud | change |
| Open ticket contents and item status | POS → cloud | relay frame |
| Customer orders | cloud → POS | relay push, POS acknowledges |
| Guest ordering settings | portal → POS | narrow allowlisted command, see below |

**The POS is the source of truth for menu, prices, tables and stock.** The cloud copy is a cache and
an order inbox. The cloud never invents a product and never prices one.

**Cost, stock, SKU, supplier, staff, payments and customer records are not in this sync.** The
public menu payload is the same reduced shape the guest server already sends today (`id`,
`category_id`, `name`, `description`, `price`, `has_image`).

---

## Letting the portal write — the one genuinely new risk

Every cloud command the POS accepts today is read-only: `health.get`, `orders.live`, `orders.get`,
`report.sales`, `report.dashboard`, `report.hourly`, `report.items`, `report.payments` (see the
command switch in `main/services/cloud-sync.ts`). The cloud can ask the POS questions. It cannot
change anything. That is a deliberate posture and "configure it from the portal" reverses it.

It is still doable, but only narrowly:

- **A closed allowlist, not a generic settings write.** One command family, `settings.guest.*`, that
  can touch exactly: `guest_ordering_enabled`, `guest_public_url`, and per-table token rotation.
  Anything else is rejected by the POS, including an unrecognised key inside a valid command.
- **An opt-in on the machine.** "Let the portal manage customer ordering" is presented once, during
  pairing, on the POS screen, and defaults to off. The owner authorises remote writes while standing
  at their own machine.
- **POS-side authorization, not cloud-side.** The command carries the portal actor's identity; the
  POS checks the linked account is still linked and still owner/manager before applying. A command
  for a revoked link is dropped and logged.
- **Audited as cloud-sourced.** Each applied write goes to the audit log with the actor and
  `source: 'cloud'`, so "who turned ordering on at 2am" has an answer.
- **A local override always wins.** Switching customer ordering off on the POS is immediate and
  cannot be re-enabled by a queued command that arrives afterwards.

If any of that feels like too much surface for the value, the smaller version is: **portal read-only
in v1** — it shows the settings and says "change this on the POS". Orders and menu still sync, which
is most of the benefit. Remote write lands in a later phase once the allowlist has been exercised.

---

## When the POS is offline

A customer's phone must never be told an order reached the kitchen when it did not.

- The cloud accepts the order and immediately tries to push it over the relay.
- The phone shows **"กำลังส่ง"** until the POS acknowledges, then **"ส่งเข้าครัวแล้ว"**.
- No acknowledgement within ~60 seconds: the phone shows that the order has not reached the kitchen
  and to call a member of staff. The order stays queued, and is delivered if the POS returns.
- Queued orders older than the shop's configured window are expired rather than dumped on the
  kitchen hours later.

The menu itself stays readable from cache while the POS is offline, so a customer scanning during a
brief uplink blip sees a menu rather than an error.

---

## Phasing

| Phase | Contents | Merchant-visible |
|---|---|---|
| 0 | Today: single shop, LAN, self-tunnelled | Already shipped |
| 1 | Tenant-prefixed tokens; menu and tables pushed to cloud; portal sign-in + pairing; portal **read-only** | Owner can see their shop in the portal |
| 2 | Hosted customer page; orders over the relay with POS acknowledgement | Customers order over mobile data with no tunnel to run |
| 3 | Allowlisted portal writes behind the pairing-time opt-in | Settings changeable from the portal |

Phase 1 is independently useful and carries no new write risk, so it is the right thing to build
first even if 3 is the goal.

---

## Phase 1, as built

Only the POS side is in this repository. Portal sign-in, pairing redemption and the hosted server
are FloAdmin work and are **not** implemented here.

| Piece | Where |
|---|---|
| Token format, qualify/parse/hash | `main/services/guest-tokens.ts` |
| Store reference captured at registration | `main/services/cloud-sync.ts` → `cloud_store_ref` |
| Public menu + table hashes, one definition | `main/services/public-menu.ts` |
| Tenant check before a token lookup | `main/guest-server.ts` → `tableForToken()` |
| QR codes printed with the prefix | `main/routes/guest-ordering.ts` → `guestUrl()` |
| Snapshot push | `main/services/cloud-sync.ts` → `publishPublicOrderingSnapshot()` |
| Tests | `npm run test:public-ordering` |

**How the snapshot is pushed.** A 60-second timer compares a digest of the public snapshot against
`cloud_public_ordering_digest` and enqueues `public_ordering.snapshot` on the existing cloud outbox
when it differs. Polling rather than hooking every product and table write: a menu changes rarely,
the payload is small, and a digest cannot be forgotten at a call site the way a `notify()` can.

**It only runs while customer ordering is switched on.** There is no reason for the menu to leave
the machine otherwise. Switching the feature off enqueues `public_ordering.withdrawn` and clears the
digest, so turning it off takes the hosted menu down rather than merely freezing it.

**Nothing new is writable from the cloud.** The command switch still handles only `health.get`,
`orders.*` and `report.*`, and the test asserts that — a write command appearing there has to be a
deliberate, reviewed change.

### What FloAdmin has to provide for phase 1 to do anything

1. `store_ref` in the `/api/pos/register` response: short, opaque, unique, matching
   `[A-Za-z0-9_-]{1,32}`.
2. Acceptance of the `public_ordering.snapshot` and `public_ordering.withdrawn` event types on
   `POST /api/pos/events`.
3. Portal sign-in (federated), and pairing-code redemption that links a portal account to a store.

Until (1) ships, the POS keeps printing bare codes and everything works exactly as it does now.
Until (2) ships, the events queue and retry harmlessly.

---

## Non-goals

- Publishing ports 3001, 3002 or 3003 — never, in any phase.
- Cloud storage of POS staff passwords or password hashes.
- Creating POS staff accounts from the portal.
- Cloud access to cost, stock, staff records or payment instruments.
- Any POS write path from the cloud outside the `settings.guest.*` allowlist.
- Making the shop depend on the internet to take an order.

---

## Open questions for the merchant

1. **Domain shape.** `https://order.example.com/?t=<store_ref>.<secret>` is simplest — one
   certificate, one host, tenant carried by the token. Per-shop subdomains look nicer on a printed
   sticker but need wildcard TLS and more DNS. Recommendation: single host.
2. **Who runs the server** — the existing FloAdmin host, or a separate box. A separate box keeps the
   public attack surface away from the admin control plane. Recommendation: separate.
3. **Portal write in v1, or read-only first** (see above). Recommendation: read-only first.
4. **Queue window** when the POS is offline — how long a queued order stays valid.
