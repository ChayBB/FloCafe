# Business decisions

**Status: CURRENT**

This is the canonical log of explicit product/business decisions — rules chosen by the product owner that shape FloCafe's behavior and aren't derivable from reading the code alone. It exists so that anyone (human or AI agent) making a change can check whether their approach would silently contradict a decision that was already made deliberately, rather than rediscovering or re-litigating it.

**Before implementing a change that touches authorization, access control, defaults, or another area covered below, read this file.** If a task seems to require deviating from a decision here, stop and confirm with the user explicitly — do not assume the decision is stale or was a mistake just because it's inconvenient for the task at hand. If a decision genuinely no longer fits (the product has grown, a new constraint appeared), update this file in the same change that changes the behavior, with a note on what changed and why — never let code and this document drift apart silently.

This document is a peer of the `AGENTS.md` core invariants, not a replacement: invariants there are the small set of load-bearing rules every change must respect; this file is the fuller, growing log of specific decisions, including narrower ones that wouldn't belong in that short list.

## How entries are structured

Each decision states: the rule, why it exists, where it's enforced in code, how to verify the codebase still complies, and when it was decided. "How to verify" should be something an agent can actually run (a grep, a test suite) — a decision without a verifiable check is easy to violate by accident.

---

## Orders are never ownership-gated

**Rule:** Any staff role with order access (owner, manager, cashier, server — see `docs/roles-and-permissions.md`) can view and act on **every** order, regardless of who created it. There is no "this is my order" restriction anywhere in the system.

**Why:** FloCafe is an open system by design. Restricting staff to only the orders they personally created adds friction (a waiter covering a colleague's table, a manager checking in on any order) without a real security benefit for this product — accountability comes from knowing who did what, not from hiding data between staff who already share a till and a kitchen.

**What restriction remains instead:**
1. **Role-based page/feature access** — e.g. chef cannot open the Orders page at all; cashier cannot access owner/manager-only settings.
2. **Role-based restriction on a specific action** — e.g. KDS stage transitions (marking an item "preparing"/"ready"/"served") are chef/manager/owner-only (`ROLE_ACCESS.kitchen`), further narrowed by the chef's assigned kitchen station and category (see `main/routes/order-items.ts`). A server can place an order but cannot do the kitchen's job on it.
3. **Audit attribution** — every order and write is still recorded against the authenticated actor (`user_id`, `created_by`, etc.). This is for the audit trail (who did what), not for gating access.

**Enforced by (i.e., where this would be violated if reintroduced):** `main/routes/orders.ts` (order list, `GET /:id`, `POST /:id/items`, `PATCH /:id/status`), `main/routes/index.ts` (item cancel/void), `main/routes/printers.ts` (`print-kot`). None of these compare `order.user_id` (or an item's creator) against the requesting user to decide access.

**How to verify:** `grep -rn "role === 'server'" main/routes/ | grep -i "user_id"` (or similarly, `grep -rn "user_id !== " main/`) should return **nothing**. If it returns a match, that's a reintroduction of this pattern and should be treated as a bug, not a feature — confirm with the user before keeping it.

**Decided:** 2026-09-12. Reverses a restriction that existed in the codebase and was at one point documented as fixing "vuln-0007: IDOR on Order List Endpoints" (see `tests/security-hardening.test.ts` history) — that framing was the prior, now-corrected understanding; this entry is the current one.

---

## Server App table assignments

**Rule:** A `server` may be assigned specific tables (Staff page > Tables). Once a server has at least one assignment, the Server App only lets them open or append orders on those tables, and its table picker hides the rest. A server with **no** assignment rows keeps access to every table. Managers and owners are never table-scoped, and the restriction applies only to the Server App (`:3003`) — the dashboard POS is unaffected.

**Why:** Larger floors split sections between waiters, and the merchant asked to stop a waiter picking up a table another section is responsible for. Scoping by assignment keeps that operational boundary without gating anything by who created an order.

**Relationship to "Orders are never ownership-gated" (above):** This does not reverse that decision. It is the same shape as the chef's KDS station scope — a **role-based restriction on a specific action, narrowed by assignment**. No `order.user_id` is compared against the requester anywhere: a scoped server still sees and reads every order, including orders on tables they are not assigned to. Only the write path (create order / append items) is scoped, and only by table.

**Enforced by:** `main/server-app.ts` (`requireTablePermission` on `POST /api/orders` and `POST /api/orders/:id/items`, table-list filtering on `GET /api/tables`), backed by `isTableAllowedForUser()`/`getUserTableIds()` in `main/db.ts`. Assignments are stored in `table_users` (migration v87) and managed via `GET`/`PUT /api/staff/:id/tables` (owner/manager only).

**How to verify:** `npm run test:server-app-table-permissions` — covers the unassigned-server default, table-list filtering, 403 on an unassigned table for both create and append, owners being unscoped, and the invariant that a scoped server can still read orders from other tables.

**Decided:** 2026-09-21.

---

## Customers can order without an account, scoped by a table's QR token

**Rule:** A customer scans the QR on their table and orders from their own phone. They never sign in and no account is created for them. Holding a table's `guest_token` is what authorises ordering, and it authorises **only** that table: the menu, that table's open ticket, and adding lines to it. Customer orders go straight to the kitchen with no staff approval step, and are attributed to a locked system account (`guest-ordering`, `is_active = 0`, unusable password) because every order write records an actor against a `NOT NULL` foreign key.

**Why:** Guests should not have to install an app, create an account or hand over a phone number to order a coffee. A per-table secret is both less friction and less data to hold than customer accounts. Orders skip staff approval because the merchant asked for it: the kitchen screen is the check, and an unwanted line is cancelled there.

**The feature is off until the merchant turns it on** (`guest_ordering_enabled`, default off). While off, every guest route answers 404.

**What a token does *not* open:** payments, bills, the table list, other tables' tickets, customer records, product cost or stock, staff login, or any POS route. The guest surface runs on its own port (`main/guest-server.ts`, default 3004) that serves only `/api/guest/:token/*` and the customer page; every other `/api/*` path there returns 404. This separation is what makes it safe for the merchant to publish that one port to the internet — publishing 3001/3002/3003 would expose staff and money endpoints and must never be done.

**How a guest order reaches the POS:** the guest server calls the POS API over loopback carrying a secret generated per process and held only in memory (`main/services/guest-channel.ts`). The POS API accepts it for exactly two routes — `POST /api/orders` and `POST /api/orders/:id/items` — and only from a loopback socket. Nothing else is reachable that way.

**Abuse limits:** 10 orders per minute per IP, at most 40 lines per order, quantity 1–20 per line, and every product id is re-checked against the live menu before it becomes an order line. Rotating a table's code (Settings → Customer QR ordering) invalidates the printed one immediately.

**How to verify:** `npm run test:guest-ordering` — covers the disabled default, token scoping, rotation, the hidden cost/stock fields, input rejection, and that no staff route or login is reachable on the guest port.

**Decided:** 2026-09-26.

---

## A portal account is linked to a shop by pairing, never by a matching email

**Rule:** When customer ordering is hosted for many shops, signing in to the portal with the same
email address as the POS owner does **not** by itself grant access to that shop. Linking a portal
account to a store requires two proofs at once: control of the mailbox (federated sign-in) *and* a
short-lived single-use code displayed on the POS screen to an owner or manager. Later sign-ins use
only the first, because the link is already recorded. A portal account and a POS staff account stay
separate objects: the portal never stores POS passwords and never creates POS staff accounts.

**Why:** the owner's email is printed on receipts, invoices and the shop's public listings. It is an
identifier, not a secret. If matching it were sufficient, anyone who read a receipt could claim the
shop. The email says *which* store; the pairing code is what authorises the link.

**Also decided (2026-09-26): the portal is read-only to begin with.** Every command the POS accepts
from the cloud is a read (`health.get`, `orders.*`, `report.*`). Portal-initiated settings writes are
deferred to a later phase and, when they arrive, are limited to a closed allowlist
(`guest_ordering_enabled`, `guest_public_url`, table token rotation) behind an opt-in given on the
POS machine itself, with a local change always winning.

**What may leave the machine:** while customer ordering is switched on, the customer-facing menu and
the shop's table list are pushed to the cloud so a hosted server can render them. Table codes go as
`sha256` hashes of the qualified token, never as the tokens themselves, so a breach of the hosted
server produces no working QR codes. Cost, stock, SKU, supplier, staff and payment data are not in
the payload. Switching the feature off withdraws the hosted copy rather than freezing it.

**Enforced by:** `main/services/public-menu.ts` (the single definition of the public payload — the
forbidden columns are never selected, not selected-then-stripped),
`main/services/guest-tokens.ts` (`isTokenForThisStore`), `main/guest-server.ts` (`tableForToken`
checks the tenant before the lookup), `main/services/cloud-sync.ts`
(`publishPublicOrderingSnapshot`).

**How to verify:** `npm run test:public-ordering` — covers token parsing, another shop's prefix
opening nothing, back-compatibility with codes printed before registration, the absence of
cost/stock/SKU and of plaintext tokens in the snapshot, and an assertion that the cloud command
switch still contains no write commands.

**Decided:** 2026-09-26. Design and later phases: `docs/public-ordering-multitenant.md`.

---

## Front-of-house staff can cancel a pending line

**Rule:** A `cashier` or `server` can cancel an individual order item **only while that item is still `pending`** — the kitchen has not started it. Once an item reaches `preparing` or `ready`, cancelling it is a void and still requires an owner/manager approval PIN, exactly as before. Owner and manager keep their existing unrestricted item cancel.

**Why:** Guests change their mind seconds after ordering. Making a waiter find a manager to drop a line the kitchen has not touched is friction with no control value — nothing has been produced or consumed yet, and the actor is recorded on the cancellation either way.

**What did not change:** the manager-PIN void path for in-progress items, the block on cancelling items of a paid or partially paid order, and the rule that cancelling the last live line cancels the order.

**Enforced by:** `canCancelPendingItem` in the `PATCH /api/orders/:orderId/items/:itemId/cancel` handler (`main/routes/index.ts`). The Server App forwards this route under the same table scoping as its other writes.

**How to verify:** `npm run test:server-app-table-permissions` (a scoped server cancels a pending line on their own table and is refused on another table) plus `npm run test:cancel-override` for the PIN path.

**Decided:** 2026-09-21.

---

## Servers can take payment

**Rule:** The `server` role can settle a bill, alongside owner, manager, and cashier. Concretely, servers may generate a bill, read it, take a payment (single or split batch), and print it. Bill **discounts** and `markPrinted` stay owner/manager-only, and the bill list (`GET /api/bills`) stays owner/manager/cashier.

**Why:** Waiters settle at the table in this merchant's service model, so routing every payment back through a till person added a step with no control benefit — the actor is recorded on every payment line either way. Previously `billsPayments` was owner/manager/cashier, which made the Server App's payment button impossible.

**Enforced by:** `ROLE_ACCESS.billing` in `shared/role-permissions.ts` (owner, manager, cashier, server), used by the widened routes in `main/routes/bills.ts` and by the `billsPayments` capability in the permission matrix. The Server App forwards `/api/bills/generate`, `/api/bills/order/:orderId`, and `/api/bills/:id/payments`, each still subject to the table scoping above.

**Note:** `ROLE_ACCESS.ownerManagerCashier` is deliberately left unchanged — it also gates the POS terminal, and this decision is about billing, not about giving servers the POS.

**How to verify:** `npm run test:server-app-table-permissions` (a server settles a bill through the Server App) plus `npm run test:authz-phase3` and `npm run test:security`.

**Decided:** 2026-09-21.

---

## Refunds and Staff Approval PINs

**Rule:** The initial owner must create and confirm a separate 4-6 digit Staff Approval PIN during first-run setup. It is stored as a bcrypt hash in the owner user record and is independent from the device Master PIN. Owners (and, within the first hour of an order, managers too) can refund a bill that has already been paid — in full, partially, or for a single item — without restocking inventory. The refund can be paid back in a different method than the customer originally used, or issued as store credit. Specifically:

1. **Selected approver:** every refund request must identify one approver with `approver_id`. `manager_id` remains a compatibility alias, but missing IDs and conflicting `approver_id`/`manager_id` values are rejected. Only the selected active owner or manager is checked, and the submitted PIN must be that user's Staff Approval PIN. The device Master PIN never authorizes a refund.
2. **Ceiling:** a refund can never exceed `paid_amount − sum(prior refunds)` for that bill (not the order's gross total), so a bill already partially refunded can't be refunded again past what's actually left outstanding. Enforced by `getRefundableBalance()` in `main/services/refund.ts`.
3. **Approval tiers, keyed off the order's `created_at`:**
   - Within 1 hour of order creation: the selected active owner's or manager's Staff Approval PIN (in-progress orders, unchanged).
   - After 1 hour but still the same business day (per the tenant's configured timezone and `business_day_start_time`, via `dayBoundsInTimezone()`): the selected active owner's Staff Approval PIN only - a manager PIN is rejected outright. There is no kitchen/service context left to sanity-check a request once the order is effectively closed, so the bar is raised rather than reused.
   - Once the order's business day has ended: refused entirely (409), regardless of who approves. A merchant needing to reverse an older transaction does so outside the system (e.g. a manual adjustment), not through this endpoint.
4. **Item eligibility** for a single-item refund now includes `served` and `completed`, not just `preparing`/`ready` — a served/completed item is exactly what "already-completed order" refunds are for.
5. **Refund payment method is independent of the original payment method(s)** — a card payment can be refunded in cash, or vice versa. This is deliberate (per the product decision behind this feature), not a validation gap.
6. **Store credit** (`method: 'wallet'`) requires loyalty to be enabled and the bill to have a customer attached. It's recorded as a plain `credit` row in `loyalty_ledger` (the same mechanism cashback uses), so it's immediately spendable — no separate "refund credit" ledger type exists. This does **not** double-count as cashback on respend: `calculateCashback()` in `main/routes/bills.ts` already excludes wallet-funded spend from the cashback base.
7. **Accepted limitation:** refunding an item/order does **not** claw back cashback that was already credited on that sale at payment time. Given FloCafe's current install-base scale (see `AGENTS.md` "Lessons from past mistakes"), building proportional cashback clawback was judged not worth the complexity for a v1. Revisit if this is observed to be abused.
8. **No per-role permission grant exists yet.** Refund initiation is gated the same way it already was (`ROLE_ACCESS.ownerManager` at the route), not by a configurable owner-editable grant — `docs/roles-and-permissions.md` already documents that role configuration/IAM isn't available. Letting an owner grant refund access to other roles (e.g. cashier) is deferred to that future IAM work, not built here.
9. Inventory is never restored by a refund (item-level or whole-bill) — consistent with how item voids/cancellations already behave.

**Why:** Requested as a controlled way to reverse completed sales without reopening the order-editing surface, while keeping the two things most exposed to misuse — how far back a refund can reach, and who can approve one — deliberately tight (same-business-day cutoff, owner-only once the in-progress window has passed).

**Enforced by:** `main/routes/auth.ts` (`/setup/initialize`), `main/services/refund.ts` (`createRefund`, `resolveRefundApprover`, `REFUND_ITEM_ELIGIBLE_STATUSES`), `main/routes/refunds.ts`, and `frontend/src/components/orders/RefundModal.tsx`. Audit trail: every refund now also writes a `refund_issued` row to `order_audit_log` (previously refunds were only recorded in the `refunds` table).

**How to verify:** `npm run test:refunds` (original in-progress-refund behavior, budget-sensitive — see that file's header) and `npm run test:refund-completed-orders` (business-day tiers, expanded item eligibility, store credit, and the audit-log entry).

**Decided:** 2026-09-17.

---

## Regional settings come from signup, never from a fallback

**Rule:** The country the owner selects during first-run setup — and the ISO 4217 currency that follows from that country's profile (changeable later to another valid code in Business Settings) — are the only source of a store's regional identity. Currency symbol, symbol position, fraction digits, number separators, and the default timezone are **derived** from those two values using international conventions (CLDR via `Intl`, ISO 4217, IANA time zones). There is no default country, no hard-coded currency symbol, and no per-store override of a derived value anywhere in the codebase. If regional settings are missing, code fails loudly (`RegionalNotConfiguredError`, HTTP 409) rather than rendering India.

**Why:** Before this decision the codebase carried `'IN'` / `'INR'` / `'₹'` / `'Asia/Kolkata'` as silent fallbacks in more than a dozen places, the install seed wrote them before the owner had chosen anything, and surfaces disagreed on which symbol to print. A non-Indian store could see rupees on one receipt and its own currency on another. The owner's instruction: the user picks country and currency at signup, it stays consistent throughout the application, and the app follows the conventions people already use rather than inventing overrides.

**What this rules out:** merchant-editable currency symbols and merchant-selectable prefix/suffix placement (both asked for in issue #693). If a locale's rendering is wrong, the fix is the country profile in `main/countries.ts`, which corrects every store in that country.

**Enforced by:** `docs/regional-snapshot.md` (ACTIVE DESIGN) — `resolveRegionalSnapshot()` in `main/countries.ts` once implemented, the first-run wizard requiring a country, `POST /setup/initialize` rejecting a missing country, and `seedInstallDefaults()` in `main/db.ts` no longer writing regional keys.

**How to verify:** `grep -rn "|| 'IN'\|?? 'IN'\||| 'INR'\|?? 'INR'\||| '₹'\|?? '₹'\||| 'Asia/Kolkata'\|?? 'Asia/Kolkata'\|getCountryByCode('IN')" main frontend/src shared --include='*.ts' --include='*.tsx'` should return nothing outside test files. A match is a reintroduced fallback and should be treated as a bug.

**Decided:** 2026-09-18.

---

*(Add new decisions above this line, most recent first is not required — organize by topic. Keep each entry self-contained: a future reader should not need this conversation's context to understand the rule, why it exists, or how to check it.)*
