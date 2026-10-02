# Extracting features into plugins

Status: **PROPOSED** — assessment and sequencing only. Nothing here is built.

Written to answer one question: how much of FloCafe could be moved out of the
core app and into the plugin model that
[FloCafe-Plugins](https://github.com/FreeOpenSourcePOS/FloCafe-Plugins)
describes. The short answer is *none of it yet*, and this document is mostly
about what would have to exist first.

---

## 1. What the plugin repository is today

**Signed data, not code.** FloCafe-Plugins publishes country tax packs as JSON,
either plain (`main/tax-packs/*.json`) or wrapped in a
`artifactType: "country-tax-pack-plugin"` envelope that carries a digest, a
publisher and a `minFloVersion` around an inner `taxPack`.

The loader on this side matches that. `main/tax-packs/catalog.ts` verifies a
signature and parses JSON; there is no `require()`, no dynamic `import()`, no
hook registry and no ABI. Nothing in the repository executes.

The README's *Capability Plugin Direction* section is explicit that the
executable layer is a direction rather than a thing that exists — "the same
catalog and signature model **is intended to grow** into capability plugins",
"**Future** executable plugin manifests should declare…".

So the gap is not that FloCafe's features are badly shaped for plugins. There is
currently nothing to plug them into.

What the direction does already fix, and what this document treats as settled:

- signed artifacts, immutable once released
- installation and activation are separate actions
- a plugin declares its permissions and its allowed outbound hosts
- external executable code runs isolated from Electron main and from SQLite
- provider credentials live in a hosted connector, not on the POS
- the POS sits behind NAT, so provider webhooks must not terminate on it

That last pair matters more than it first looks: it decides that some of what
follows should become a *hosted connector*, not a local plugin.

---

## 2. What core would need first

Every feature assessed below trips at least one of these. They are listed in the
order they would have to be built.

### 2.1 A plugin may own its own schema

Migrations are a single ordered array in `main/db.ts`, applied by
`if (migration.version <= current) continue` with `user_version` tracking the
high-water mark. Two consequences:

- Two authors editing at once collide on the next number. This is not
  hypothetical — it happened during the work assessed here, and the hazard is
  worse than a merge conflict: a machine that runs `v75` before `v74` exists
  will never run `v74` at all, because the version is already past it.
- A plugin cannot ship a table. There is no per-plugin migration namespace and
  no way to roll one back on uninstall.

Needed: migrations scoped per plugin id, versioned independently of core, with
an uninstall path that is explicit about whether data is kept or dropped.

### 2.2 Events a plugin can subscribe to

There is no general bus. What exists is two ad-hoc ones —
`registerDatabaseMaintenanceStartListener()` in `main/db.ts` and
`onOrderItemStatus()` in `main/services/server-app-events.ts`. The second was
added precisely because the alternative was an import cycle, which is a hint
that the shape is right and only the scope is too narrow.

Needed: a named, documented set of events with stable payloads. The minimum this
assessment implies: `staff.signed_in`, `staff.signed_out`, `order.created`,
`order.paid`, `order_item.status_changed`, `table.session_ended`.

Payload stability is the hard part. An event that hands out a raw row re-exports
the schema and makes every future column a compatibility problem.

### 2.3 A plugin may contribute HTTP surface

Routes are registered by `registerRoutes()` against a fixed list, and extra
surfaces (KDS, Server App, guest gateway) are separate servers started by
`main/index.ts` on fixed ports.

Needed: a way for a plugin to register routes under a namespace it owns
(`/api/plugins/<id>/…`), and — for anything customer-facing — to be given a port
rather than opening one itself.

### 2.4 A plugin may contribute UI

**This is the hardest one.** The frontend is a Next.js *static export*
(`NEXT_BUILD_MODE=desktop`, output in `frontend/out`). Pages are generated at
build time. A plugin installed afterwards cannot add a route, a settings tab or
a dashboard card, because there is no build step left to run.

Needed: a runtime extension surface — declared slots the shell fills from
installed plugins, rendered from data rather than from compiled components, or a
genuinely different frontend architecture. This is a change of approach, not an
API addition, and it is the single largest piece of work in this document.

### 2.5 A plugin may contribute translations

Locale files are imported directly in `frontend/src/lib/i18n/languages.ts` and
bundled at build time, and `npm run test:translations` enforces key parity
across all ten locales. Every feature assessed below adds 20–60 keys.

Needed: a plugin-scoped message namespace loaded at runtime, and a parity rule
that applies per plugin rather than to one global set.

### 2.6 A data API, so plugins need not touch SQLite

The direction document already requires this: *external plugins must not access
raw SQLite tables*. Every feature assessed below reads and writes SQLite
directly today.

This is larger than the plugin loader itself. A plugin that cannot query the
database needs a sanctioned read/write API for orders, tables, staff and
settings, with its own permission model — effectively a second public API
surface to design, document and keep stable.

---

## 3. Feature-by-feature assessment

| Feature | Verdict | What blocks it |
|---|---|---|
| mDNS discovery | Extractable, low value | Nothing much. But it has no configuration, every install wants it, and extracting it buys nothing. |
| Staff work hours | **Best candidate** | Needs 2.1–2.5. Touches no decision the shop depends on. |
| Profit report | Possible later | Needs a report slot (2.4) and an `order.created` hook to snapshot unit cost. |
| Customer QR ordering | Hard | Trips every item in §2. Better as a hosted connector — see below. |
| Per-staff table permissions | **Should not be a plugin** | It is authorization in the request path. |
| Username / optional email | **Should not be a plugin** | Core identity and the sign-in path. |

### Staff work hours — why it is the right pilot

It is a pure observer. It listens for sign-in and sign-out, writes to a table
nobody else reads, and renders a report. It changes no decision the business
depends on: if the plugin fails to load, nobody can see last month's hours and
the shop keeps selling.

That property is what makes it a safe first subject. It also happens to exercise
four of the five capabilities above — schema, events, a route, a UI slot and
translations — which means building it proves the platform rather than just
moving code.

Shape it would take:

```
plugin: flo-staff-hours
  schema:   staff_work_logs (owned, versioned by the plugin)
  events:   staff.signed_in, staff.signed_out
  routes:   GET /api/plugins/flo-staff-hours/report?year&month
  ui:       slot "staff.page.section" → month calendar
  i18n:     18 keys × 10 locales, namespaced
  perms:    read staff names; no order, payment or customer access
```

The one piece that does not fit cleanly: hours are *derived* by pairing events,
and a shift still running has no end yet. That logic has to live somewhere the
report can reach, which is fine inside the plugin — but it means the plugin owns
a rule the shop may care about (how an unclosed shift is treated). Worth being
deliberate that this is plugin-owned policy, not core policy.

### Customer QR ordering — connector, not plugin

It needs its own HTTP port, a loopback channel into the POS API, an
authentication bypass for exactly two routes, five migrations, a customer-facing
page inside the static export, and an owner settings tab. Every one of §2's
gaps, at once.

More importantly, the direction document already argues against it being local:
the POS is behind NAT, provider-facing traffic should not terminate on it, and
hosted connectors should normalize events and deliver them back through the
outbound cloud channel. That is the same conclusion
[public-ordering-multitenant.md](public-ordering-multitenant.md) reached
independently. The guest surface should become a hosted service with the POS
holding an outbound connection, not a plugin installed on the till.

### Why the two "should not" rows are not negotiable

**Table permissions** decide whether a request is allowed to create an order on
a given table. Moving that out of core means either the plugin runs inside the
request path with database access — which the direction document forbids — or
core asks an isolated process for permission on every write, which is a new
failure mode on the hot path for a rule that fits in twenty lines.

**Username and optional email** change the `users` schema and the lookup every
sign-in performs. An identity provider plugin is a reasonable thing to want
eventually; *the primary local login* is not a plugin.

A useful rule from both: a plugin may **observe** and may **add** surface. A
plugin that **denies** something, or that owns the only path to a credential,
belongs in core until the isolation story is real.

---

## 4. Suggested order

1. **Per-plugin migrations** (§2.1). Independently worth doing — it fixes the
   numbering hazard that already exists between two humans.
2. **Event bus** (§2.2), generalising the two ad-hoc listeners that exist.
3. **Namespaced routes** (§2.3).
4. **Plugin i18n** (§2.5).
5. **UI slots** (§2.4) — the large one; worth prototyping against exactly one
   slot before committing.
6. **Extract staff work hours** as the first plugin, end to end.
7. Only then decide whether anything else is worth moving.

Steps 1 and 2 pay for themselves whether or not plugins ever ship. Step 5 does
not; it should not be started until something concrete depends on it.

## 5. Open questions

- Does a plugin's data survive uninstall? Attendance records are the kind of
  thing a shop expects to keep, and the kind of thing an uninstall usually
  destroys.
- What happens to a plugin's tables when core restores a backup taken before the
  plugin existed, or when `test:upgrade-path` walks an old install forward?
- Does the signing requirement apply to first-party plugins too? If yes, the
  release process grows a step for every extracted feature.
- Is there a version of this where plugins are build-time rather than runtime —
  chosen per install, bundled by the installer? That sidesteps §2.4 entirely and
  may be enough for an offline-first desktop POS.
