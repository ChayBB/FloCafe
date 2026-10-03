# FloCafe guest relay server (reference)

Status: **REFERENCE — never run or deployed by its authors.**

Bun + Elysia + PostgreSQL + Caddy. Implements the hosted half of
[`docs/guest-relay-protocol.md`](../../docs/guest-relay-protocol.md): it serves
the customer's phone over the public internet, holds the socket the POS dials
out to, and carries orders between the two.

**None of this has been executed.** Bun is not installed on the machine where it
was written, so it has not been started, and no order has ever gone through it.
The POS end is the tested half (`npm run test:guest-relay`, 8 cases including
the ones this server's correctness depends on). Treat this as a worked example
of the contract, not as something proven.

```
customer phone ──HTTPS──> Caddy ──> Bun/Elysia ──> PostgreSQL
                                        ▲
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

**It never tells a customer their food is coming until the POS says so.** The
phone shows "sending" until an `ack` arrives. That is the single rule most
worth keeping: a queue that silently swallows an order is worse than one that
admits it failed.

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

## Files

| | |
|---|---|
| `schema.sql` | PostgreSQL tables |
| `src/index.ts` | Elysia app: customer HTTP + the POS socket |
| `src/pos-link.ts` | the POS connection, hello verification, order dispatch |
| `src/db.ts` | queries |
