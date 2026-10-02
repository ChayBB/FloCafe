/**
 * Unit tests for mDNS service discovery (main/services/flo-discovery.ts).
 *
 * Covers the parts that decide whether a companion device can actually dial the
 * POS once it has found it:
 *  - TXT values are strings, because mDNS carries bytes and a number is
 *    stringified by one implementation and dropped by another;
 *  - an IPv4 literal is preferred over the `.local` hostname, which needs a
 *    resolver that Android and many corporate networks do not have;
 *  - a service that is not a FloCafe POS is rejected, which is what makes
 *    browsing the shared `_http._tcp` type survivable;
 *  - the advertised name is unique per machine, so two tills do not collide.
 *
 * Run: npm run test:flo-discovery
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import type { Service } from 'bonjour-service';
import {
  FLO_SERVICE_TYPE,
  floServiceName,
  floTxtRecord,
  toFloInstance,
  createInstanceTracker,
} from '../main/services/flo-discovery';

/** A discovered service, shaped like the fields bonjour-service fills in. */
function service(overrides: Partial<Service> = {}): Service {
  return {
    name: 'Flo POS (till-01)',
    type: FLO_SERVICE_TYPE,
    protocol: 'tcp',
    host: 'flo.local',
    port: 3001,
    addresses: ['192.168.1.42'],
    txt: { version: '3.9.0', api: '/api', kds_port: '3002', server_app_port: '3003' },
    ...overrides,
  } as Service;
}

test('TXT values are strings, never numbers', () => {
  const txt = floTxtRecord({ version: '3.9.0', kdsPort: 3002, serverAppPort: 3003 });
  for (const [key, value] of Object.entries(txt)) {
    assert.equal(typeof value, 'string', `${key} must be a string in a TXT record`);
  }
  assert.equal(txt.kds_port, '3002');
  assert.equal(txt.server_app_port, '3003');
});

test('the advertised name carries the machine name so two tills do not collide', () => {
  const name = floServiceName();
  assert.match(name, /^Flo POS/);
  const machine = os.hostname().replace(/\.local$/i, '').trim();
  if (machine) assert.ok(name.includes(machine), 'the machine name is part of the advertised name');
});

test('a discovered POS becomes dialable URLs', () => {
  const instance = toFloInstance(service());
  assert.ok(instance);
  assert.equal(instance.apiUrl, 'http://192.168.1.42:3001');
  assert.equal(instance.kdsUrl, 'http://192.168.1.42:3002');
  assert.equal(instance.serverAppUrl, 'http://192.168.1.42:3003');
  assert.equal(instance.version, '3.9.0');
});

test('an IPv4 address beats the .local hostname', () => {
  // flo.local only resolves where an mDNS resolver exists; the IP always works.
  const instance = toFloInstance(service({ addresses: ['fe80::1', '192.168.1.42'] }));
  assert.ok(instance?.apiUrl.includes('192.168.1.42'), 'IPv4 is chosen over IPv6');

  const v6Only = toFloInstance(service({ addresses: ['fe80::1'] }));
  assert.equal(v6Only?.apiUrl, 'http://[fe80::1]:3001', 'an IPv6 literal is bracketed');

  const noAddresses = toFloInstance(service({ addresses: [] }));
  assert.equal(noAddresses?.apiUrl, 'http://flo.local:3001', 'the hostname is the fallback, not the default');
});

test('a service that is not a FloCafe POS is rejected', () => {
  // What browsing the shared _http._tcp type actually turns up.
  const printer = service({ type: 'http', name: 'HP LaserJet', txt: { ty: 'HP LaserJet' } });
  assert.equal(toFloInstance(printer), null);

  const nas = service({ type: 'http', name: 'Synology', txt: {} });
  assert.equal(toFloInstance(nas), null);

  const noTxt = service({ type: 'http', txt: undefined });
  assert.equal(toFloInstance(noTxt), null);
});

test('a FloCafe POS on the legacy type is still recognised by its TXT keys', () => {
  const legacy = service({ type: 'http', name: 'Flo' });
  const instance = toFloInstance(legacy);
  assert.ok(instance, 'the old advertisement keeps working');
  assert.equal(instance.kdsUrl, 'http://192.168.1.42:3002');
});

test('a nonsense port in TXT does not become a URL', () => {
  // A malformed advertisement should cost the caller one missing link, not a
  // request to http://host:NaN.
  for (const bad of ['', 'abc', '0', '70000', '-1', '3002.5']) {
    const instance = toFloInstance(service({
      txt: { version: '3.9.0', api: '/api', kds_port: bad, server_app_port: '3003' },
    }));
    assert.ok(instance, `the POS is still usable with a bad kds_port (${bad})`);
    assert.equal(instance.kdsUrl, null, `kds_port "${bad}" yields no URL`);
    assert.equal(instance.apiUrl, 'http://192.168.1.42:3001', 'the API URL is unaffected');
  }
});

test('a service with no port is not dialable', () => {
  assert.equal(toFloInstance(service({ port: 0 })), null);
});

test('one POS answering on both service types is reported once', () => {
  // The server publishes under two different names — `Flo POS (till-01)` and
  // the legacy `Flo` — for the same address. Keyed by name, a picker lists the
  // same till twice; that was the behaviour before, and it only shows up when
  // both types are browsed.
  const tracker = createInstanceTracker();
  const dedicated = toFloInstance(service())!;
  const legacy = toFloInstance(service({ type: 'http', name: 'Flo' }))!;
  assert.equal(dedicated.apiUrl, legacy.apiUrl, 'both records point at the same server');

  assert.ok(tracker.up('Flo POS (till-01)', dedicated), 'the first sighting is news');
  assert.equal(tracker.up('Flo', legacy), null, 'the second record is the same server');
  assert.equal(tracker.size, 1);

  // Losing one record must not retire a server the other still advertises.
  assert.equal(tracker.down('Flo'), null, 'still up on the dedicated type');
  assert.equal(tracker.size, 1);
  assert.equal(tracker.down('Flo POS (till-01)'), dedicated.apiUrl, 'the last record going away retires it');
  assert.equal(tracker.size, 0);

  assert.equal(tracker.down('never-seen'), null, 'an unknown name retires nothing');
});

test('two different tills are both reported', () => {
  const tracker = createInstanceTracker();
  const first = toFloInstance(service({ name: 'Flo POS (till-01)', addresses: ['192.168.1.42'] }))!;
  const second = toFloInstance(service({ name: 'Flo POS (till-02)', addresses: ['192.168.1.43'] }))!;
  assert.ok(tracker.up('Flo POS (till-01)', first));
  assert.ok(tracker.up('Flo POS (till-02)', second), 'a second machine is not mistaken for the first');
  assert.equal(tracker.size, 2);
});
