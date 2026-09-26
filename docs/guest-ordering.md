# Customer QR ordering

**Status: CURRENT**

Customers scan a code on their table and order from their own phone. Orders go
straight to the kitchen. Nobody signs in: the token in the QR is what identifies
the table, and it authorises nothing else.

The policy behind this — what a token may and may not do — is recorded in
[business-decisions.md](business-decisions.md) under *Customers can order without
an account*. This file is the setup guide.

## Parts

| Piece | Where |
|---|---|
| Customer page | `frontend/src/app/guest-order/page.tsx`, served at `/guest-order?t=<token>` |
| Guest server | `main/guest-server.ts` — its own port (default **3004**) |
| Loopback order channel | `main/services/guest-channel.ts` |
| Owner settings + QR codes | Settings → **Customer QR ordering** (`main/routes/guest-ordering.ts`) |
| Table tokens | `tables.guest_token`, issued with the table (migrations v89, v91) |
| Token format helpers | `main/services/guest-tokens.ts` |
| Public menu definition | `main/services/public-menu.ts` |
| Order attribution | `guest-ordering` system user (migration v90) |

## Turning it on

1. Open **Settings → Customer QR ordering** and switch it on.
2. Every table already has its own permanent code — it is issued with the table.
   Print the sheet and stick each code on its table.
3. Scan one yourself to check the menu and prices look right.

Rotating a code (**New code**) kills the previous printout immediately — use it if
a code has been photographed or shared outside the shop.

Once the POS is registered with the cloud, printed codes carry a short store
reference in front of the secret (`<store_ref>.<secret>`) so a shared server can
tell one shop's codes from another's. Codes printed before that keep working —
see [public-ordering-multitenant.md](public-ordering-multitenant.md).

## A sitting ends when the bill is settled

The printed code identifies the table forever; a **round token** identifies one
sitting at it. Scanning exchanges the code for a round token
(`round_token` in the session response), and reading the tab or sending an order
requires it in an `X-Flo-Round` header — not in the URL, which is what ends up in
screenshots and referrer logs.

Settling the bill increments `tables.guest_round`, and every token issued to that
sitting stops verifying. The sticker on the table is untouched: the next party
scans the same QR and gets a token of their own.

The round only ends once **nothing else is still open on the table**. A table can
carry several orders at once, and ending the round while one is live would cut a
diner off mid-meal.

The binding is cryptographic rather than stored, so a sitting needs no row of its
own:

```
roundToken = <nonce>.<HMAC(secret, nonce | tableId | round)>
```

The key lives in `settings.guest_round_secret` and is minted on first use.

## Serving customers on mobile data

Out of the box the guest server listens on the shop network only, so codes work on
the shop WiFi and nowhere else. To take orders over mobile data you publish **only
port 3004** through a server you control.

> Never publish ports 3001 (POS API), 3002 (KDS) or 3003 (Server App). Those carry
> staff login, payments and the full POS API.

A reverse tunnel keeps the POS machine free of inbound firewall rules. From the POS
machine:

```bash
ssh -N -R 127.0.0.1:3004:127.0.0.1:3004 user@your-server
```

On the server, terminate TLS and proxy to the tunnel — with Caddy that is the whole
config:

```
order.example.com {
    reverse_proxy 127.0.0.1:3004
}
```

Then set **Public address** in the settings tab to `https://order.example.com`. QR
codes are regenerated against that address, and the guest server starts refusing
browser requests from any other origin.

Keep the tunnel running with your process manager of choice (systemd, autossh,
`ssh -o ServerAliveInterval=30`), otherwise codes stop working when it drops.

## Limits

- Off by default; every guest route answers 404 while disabled.
- 10 orders per minute per IP, 40 lines per order, 1–20 per line.
- The menu sent to a phone carries name, price, description and image only — no
  cost, stock, SKU or supplier data.
- Guests cannot pay, cancel, or see other tables. Payment stays with staff.
