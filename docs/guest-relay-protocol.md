# Guest order relay protocol

Status: **CURRENT (POS side)** — the hosted server is not in this repository.

How a customer ordering on mobile data reaches a till that sits behind NAT.

```
customer phone ──4G/HTTPS──> hosted QR server <──WSS, dialled by the POS── POS
```

**The POS dials out and holds the connection open.** The usual answer — tunnel a
port from the shop to a VPS — means an inbound hole into the network the till
and the card terminal live on. This way nothing in the shop listens for the
internet, the firewall stays shut, and a shop behind CGNAT works the same as one
with a static address.

This file is the contract. The POS end is `main/services/guest-relay.ts` and is
covered by `npm run test:guest-relay`, which plays the hosted server.

---

## Turning it on

Three settings, all empty by default. An unconfigured install never opens a
socket.

| Setting | Value |
|---|---|
| `guest_ordering_enabled` | `true` — the relay is part of customer ordering, not separate from it |
| `guest_relay_url` | `wss://orders.example.com/relay` |
| `guest_relay_secret` | shared with the hosted server; `newRelaySecret()` generates one |

`ws://` is refused unless the host is loopback. Orders carry what a table is
eating and what it will be charged; they do not travel in clear text across a
network.

---

## The wire

Every frame is JSON. The POS speaks first.

### POS → server: `hello`

```json
{
  "type": "hello",
  "protocol": 1,
  "pos_hash": "pos_6f0c…",
  "timestamp": "2026-10-03T10:31:25.363Z",
  "nonce": "0f6b…",
  "signature": "9ad1…"
}
```

```
signature = HMAC-SHA256(guest_relay_secret, `${pos_hash}.${timestamp}.${nonce}`)
```

The secret is never transmitted. A server **must** reject a `timestamp` outside a
few minutes and **must** refuse a `nonce` it has seen, or a captured hello can be
replayed to impersonate the till.

### POS → server: `snapshot`

Sent on connect, whenever the menu changes, and on request. The hosted server
has no menu of its own worth trusting: prices and availability belong to the
shop, and a stale copy sells something that is off, or at last week's price.

```json
{
  "type": "snapshot",
  "digest": "9f12…",
  "currency": "THB",
  "language": "th",
  "categories": [{ "id": "c-1", "name": "Drinks" }],
  "products": [{ "id": "p-12", "category_id": "c-1", "name": "Iced tea",
                 "description": null, "price": 65, "has_image": true }],
  "tables": [{ "id": "tbl-7", "number": "T9", "token_hash": "4c9b…" }],
  "captured_at": "2026-10-03T10:31:25.363Z"
}
```

Cost, stock, SKU and supplier are not in it — they are never selected, not
selected and stripped. **Tables carry only `sha256(code)`.** The phone presents
the real code, the server hashes it to find the table, and forwards the original
for the POS to re-check, so a breach of the hosted database yields no working QR.

Replace rather than merge: a product deleted upstream has to disappear, and a
diff that misses a deletion keeps selling it.

### Server → POS: `need_snapshot`

```json
{ "type": "need_snapshot" }
```

Sent when the server has no cached menu — a fresh deploy, a restarted process.
The POS answers with a `snapshot` regardless of whether anything changed.

### Server → POS: `order`

```json
{
  "type": "order",
  "id": "o-7f21",
  "table_code": "shop7.AAAABBBBCCCC…",
  "round_token": "nonce.hmac",
  "placed_at": "2026-10-03T10:30:02.000Z",
  "items": [{ "product_id": "p-12", "quantity": 2, "special_instructions": "no ice" }]
}
```

`id` is the server's own identifier and is what makes redelivery safe — see
below. `table_code` is the code printed in the QR; `round_token` is what the
customer's page received when it scanned. Both are validated against this POS,
not trusted.

### POS → server: `ack`

```json
{ "type": "ack", "id": "o-7f21", "order_id": 412, "order_number": "ORD-20261003-0007",
  "table_name": "T9", "appended": true, "replay": false }
```

`appended: true` means the lines joined a ticket the table already had open.
`replay: true` means this order had already been applied and nothing new was
cooked.

### POS → server: `nack`

```json
{ "type": "nack", "id": "o-7f21", "reason": "round_closed", "detail": "…" }
```

| reason | Meaning | What the server should do |
|---|---|---|
| `unknown_table` | the code matches no active table here | tell the customer the code is dead; do not retry |
| `round_closed` | the sitting was settled; the token is from a party that has paid | ask the customer to scan again |
| `invalid_items` | empty basket, dead product, impossible quantity | do not retry; the basket is wrong |
| `stale` | older than the acceptance window (10 minutes) | tell the customer rather than feeding them late |
| `rejected` | the POS refused it | surface `detail`; do not retry blindly |
| `error` | something broke on the POS | safe to retry |

**Every rejection is answered.** A server that hears nothing must assume the
order may have landed, and its only safe move is to send it again — so silence
causes exactly the duplicate it was trying to avoid.

---

## Redelivery

A server that does not hear an `ack` **must** resend with the same `id`.

The POS records each applied `id` and answers a repeat from what it stored,
without touching the kitchen. This is handled in the relay rather than left to
the POS's ordinary idempotency, and the reason is worth keeping: the first
delivery *opens* a ticket, so the second one would *append* to it — a different
request with the same key, which the ordinary path refuses. Dedupe has to happen
before that decision is re-made, or the retry becomes a second round of food.

Dedupe survives a restart; it is stored, not held in memory.

---

## What the hosted server still owns

Not in this repository, and not optional:

- serving the customer page and the menu (pushed up by the snapshot in
  [public-ordering-multitenant.md](public-ordering-multitenant.md))
- queueing an order while the POS is offline, and giving up when the window
  passes rather than delivering it hours later
- telling the customer the truth: *sent to the kitchen* only after an `ack`,
  never before
- rate limiting per table and per IP
- rejecting replayed `hello` frames

The last one is the POS's security boundary and cannot be enforced from this
side.

---

## Relationship to the local gateway

The gateway on port 3004 (`docs/guest-ordering.md`) is unchanged and still
serves guests on the shop's own WiFi. Both entrances share one definition of
what a guest may order — `main/services/guest-orders.ts` — because two copies
would drift, and the copy that drifts is the one that stops checking something.
