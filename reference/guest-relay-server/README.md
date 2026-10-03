# FloCafe guest relay server (reference)

Status: **REFERENCE — never run or deployed by its authors.**

Bun + Elysia + PostgreSQL + Caddy. Implements the hosted half of
[`docs/guest-relay-protocol.md`](../../docs/guest-relay-protocol.md): it serves
the customer's phone over the public internet, holds the socket the POS dials
out to, and carries orders between the two.

**None of this has been executed.** Bun is not installed on the machine where it
was written, so it has not been started, and no order has ever gone through it.
The POS end is the tested half (`npm run test:guest-relay`, 14 cases including
the ones this server's correctness depends on). Treat this as a worked example
of the contract, not as something proven.

```
customer phone ──HTTPS──> Caddy ──> Bun/Elysia ──> PostgreSQL
shop owner     ──HTTPS──>   ″           ▲
                                        │ WSS, dialled by the POS
                                        │
                                   FloCafe POS (behind NAT)
```

## Why it is shaped this way

**The POS connects to this server, never the reverse.** A till sits behind NAT
on a restaurant's broadband line. The alternative — tunnelling a port from the
shop — puts an inbound hole into the network the till and the card terminal live
on. Here nothing in the shop listens for the internet.

**This server is not the source of truth for anything.** Prices, availability
and table codes all belong to the POS. It holds a *copy* of the menu, pushed
down the socket, and it holds table codes only as hashes — the phone presents
the real code and the POS re-checks it, so losing this database does not hand
anyone a working QR.

**Pairing is how a shop publishes itself.** The owner opens `/admin`, types the
code their till is showing, and that pushes the menu up and produces the
printable QR sheet. No shop is configured on this server by hand, and no POS
password is ever typed into it.

**It never tells a customer their food is coming until the POS says so.** The
phone shows "sending" until an `ack` arrives. That is the single rule most
worth keeping: a queue that silently swallows an order is worse than one that
admits it failed.

## Pairing, and what this server can never do

Worth being exact about, because it is what makes this safe to run on a VPS.

**No POS password is ever typed here.** The merchant opens Settings → Customer QR
ordering on the till, which shows an 8-character code, and types that code at
`/admin`. This server forwards it down the socket; the till checks it. There is
nothing here to check it against, and that is the point.

So an attacker who owns this box gets: a copy of the menu (public anyway), table
codes as hashes (no working QR), and at most one pairing code that is already
spent. **Nothing that unlocks the till.**

An earlier version of this file asked for the owner's POS email and password. It
stored neither, but it did see the password in transit, and that password also
unlocks the till — so a compromised VPS could capture it. Pairing removes that
entirely. Do not reintroduce a password form here.

Four things are load-bearing and should not be "optimised" later:

- The code is checked **by the till, not here**. This server must never cache a
  code or decide for itself that one is valid.
- The pairing form is rate limited per IP (10 per 15 minutes). Not for brute
  force — the till destroys a code after five wrong guesses — but so nobody can
  hammer the form and burn every code a merchant issues.
- Sessions are a token in memory, 30 minutes, gone on restart, and dropped
  whenever the socket drops.
- Table codes fetched for printing are **never written down** and are served
  `no-store`. Snapshots carry hashes exactly so this database is worthless to a
  thief; caching the real codes gives back what the hashing protected.

## Install

```bash
curl -fsSL https://bun.sh/install | bash
sudo apt install -y postgresql caddy
```

```bash
sudo -u postgres createdb flo_relay
sudo -u postgres psql flo_relay < schema.sql
cp .env.example .env     # then edit it
bun install
bun run src/index.ts
```

### The guest page

The printed QR points at `PUBLIC_URL/guest-order/?t=<code>`, so this server has
to serve that path. It serves **FloCafe's own exported page**, not a reimplemented
one — the same build the shop's WiFi serves, so a customer on 4G and a customer
on the shop network see the same thing and hit the same bugs.

On a machine with the FloCafe repository:

```bash
npm run build:frontend
```

then copy the export across:

```bash
rsync -a frontend/out/guest-order frontend/out/_next user@your-server:/opt/flo-relay/public/
```

Nothing about the shop is baked into that HTML — the page reads `?t=` itself and
calls `/api/guest/*` — so one copy serves every shop this server hosts. Re-copy
it after a FloCafe upgrade; a page older than the API it is calling is how a
field quietly goes missing.

Set `GUEST_PAGE_DIR` if you put it somewhere other than `./public`.

### .env

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | `postgres://user:pass@localhost:5432/flo_relay` |
| `RELAY_SECRET` | must match `guest_relay_secret` on the POS |
| `PORT` | default `3000`; Caddy proxies to it |
| `PUBLIC_URL` | `https://orders.example.com` — what the QR codes point at |

Generate the secret on the POS (Settings → Customer QR ordering) rather than
inventing one here, so the two always agree.

### Caddyfile

```caddyfile
orders.example.com {
    encode zstd gzip

    # The POS holds this open. Long read timeout: it is idle between orders,
    # and a proxy that closes it makes the till reconnect all night.
    @relay path /relay
    handle @relay {
        reverse_proxy localhost:3000
    }

    handle {
        reverse_proxy localhost:3000
    }
}
```

Caddy obtains and renews the certificate itself; there is nothing to configure
for TLS. The POS refuses a plaintext `ws://` relay to a remote host, so the
certificate is not optional.

### systemd

```ini
# /etc/systemd/system/flo-relay.service
[Unit]
Description=FloCafe guest relay
After=network.target postgresql.service

[Service]
WorkingDirectory=/opt/flo-relay
EnvironmentFile=/opt/flo-relay/.env
ExecStart=/root/.bun/bin/bun run src/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## What to check before trusting it

In the order they will bite:

1. **Replayed hellos.** `verifyHello()` rejects an old timestamp and a reused
   nonce. Without both, a captured hello impersonates the till. The POS cannot
   enforce this; only this server can.
2. **Redelivery.** An order with no `ack` is resent with the same id. The POS
   deduplicates, but this server must keep sending the *same* id rather than a
   new one, or the protection does nothing.
3. **The queue window.** An order that waited out a long outage is refused by
   the POS as `stale`. The customer must be told, not left believing it arrived.
4. **Rate limits.** `/api/order` is the expensive route. The limits here are a
   starting point, not a measured value.
5. **The pairing session.** Held in memory and dropped whenever the socket
   drops. A pairing that outlives the connection lets a restarted server inherit
   privilege it never earned.

## Files

| | |
|---|---|
| `schema.sql` | PostgreSQL tables |
| `src/index.ts` | Elysia app: customer HTTP, the admin routes, the POS socket |
| `src/pos-link.ts` | the POS connection, hello verification, order dispatch, admin requests |
| `src/admin.ts` | pairing against the till, in-memory sessions, table codes |
| `src/admin-pages.ts` | the three server-rendered pages, including the QR sheet |
| `src/db.ts` | queries |
| `public/guest-order/` | FloCafe's exported guest page, copied in at deploy time |
