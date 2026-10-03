/**
 * The owner's three pages, as plain server-rendered HTML.
 *
 * No build step and no client framework on purpose: this is the surface that
 * accepts the shop's POS password, and the less code runs on it the less there
 * is to review.
 */
import QRCode from 'qrcode';
import type { PrintableTable } from './admin';

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const STYLE = `
  :root { color-scheme: light dark }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem; max-width: 60rem; margin-inline: auto }
  h1 { font-size: 1.4rem }
  label { display: block; margin-top: 1rem; font-weight: 600 }
  input { width: 100%; padding: .6rem; font-size: 1rem; box-sizing: border-box }
  button { margin-top: 1.5rem; padding: .7rem 1.4rem; font-size: 1rem; cursor: pointer }
  .error { padding: .8rem 1rem; background: #fde8e8; color: #911; border-radius: .3rem }
  .note { color: #666; font-size: .875rem }
  .offline { padding: .8rem 1rem; background: #fff6e0; color: #744; border-radius: .3rem }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: 1.5rem; margin-top: 2rem }
  .card { border: 1px solid #ccc; border-radius: .4rem; padding: 1rem; text-align: center; break-inside: avoid }
  .card svg { width: 100%; height: auto }
  .card h2 { font-size: 1.6rem; margin: .3rem 0 }
  @media print { body { padding: 0 } .no-print { display: none } .card { border-color: #000 } }
`;

function page(title: string, inner: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title><style>${STYLE}</style>
</head><body>${inner}</body></html>`;
}

export function loginPage(error?: string): string {
  return page('FloCafe — shop sign in', `
<h1>FloCafe guest ordering</h1>
${error ? `<p class="error">${escape(error)}</p>` : ''}
<p>Sign in with the same email and password you use on the till.</p>
<form method="post" action="/admin/login">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="username" required autofocus>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form>
<p class="note">Your password is checked by your own till and is not stored on this
server. Only an owner or a manager can sign in here.</p>`);
}

export function adminPage(name: string, posConnected: boolean): string {
  return page('FloCafe — guest ordering', `
<h1>Guest ordering</h1>
<p>Signed in as <strong>${escape(name)}</strong>.
  <form method="post" action="/admin/logout" style="display:inline">
    <button type="submit" style="margin:0;padding:.3rem .8rem">Sign out</button>
  </form>
</p>
${posConnected
    ? '<p>Your till is connected. The menu shown to customers is the one it last sent.</p>'
    : '<p class="offline">Your till is not connected right now. Customers cannot order until it is back.</p>'}
<p><a href="/admin/print">Table QR codes</a> — print these and put one on each table.</p>
<p class="note">Signing in is what publishes your menu here. Prices, availability and
table codes all come from the till; nothing is edited on this server.</p>`);
}

/**
 * The printable sheet.
 *
 * Served with `no-store`: each QR *is* the credential for that table, so a copy
 * sitting in a browser cache or a proxy is a copy of the credential.
 */
export async function printPage(tables: PrintableTable[]): Promise<string> {
  const cards = await Promise.all(tables.map(async (table) => {
    const svg = await QRCode.toString(table.url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return `<div class="card">${svg}<h2>${escape(table.number)}</h2>
      <p class="note">Scan to order</p></div>`;
  }));

  return page('FloCafe — table QR codes', `
<div class="no-print">
  <h1>Table QR codes</h1>
  <p>One per table. ${tables.length === 0
      ? 'No tables yet — add them on the till.'
      : `${tables.length} table${tables.length === 1 ? '' : 's'}.`}</p>
  <p class="note">A code stops working when you change it on the till, so reprint
    after that. Codes are fetched fresh each time this page loads and are not kept
    on this server.</p>
  <button onclick="window.print()">Print</button>
  <p><a href="/admin">Back</a></p>
</div>
<div class="grid">${cards.join('')}</div>`);
}
