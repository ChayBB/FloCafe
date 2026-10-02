/**
 * Which address the app tells other devices to use.
 *
 * A hypervisor or container runtime leaves a host-only adapter behind, and on
 * Windows it routinely enumerates before the real Wi-Fi card. Handing that
 * address out is worse than handing out nothing: `http://192.168.56.1:3003`
 * answers perfectly from the till and is unreachable from every phone in the
 * building, so the QR code looks correct and simply never loads.
 *
 * Run: npm run test:local-ip-ranking
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as os from 'os';
import { rankLocalIPv4 } from '../main/server-state';

function ipv4(address: string): os.NetworkInterfaceInfo {
  return { address, family: 'IPv4', internal: false } as os.NetworkInterfaceInfo;
}

test('a real Wi-Fi card beats a VirtualBox host-only adapter that enumerates first', () => {
  const ranked = rankLocalIPv4({
    'Ethernet 2': [ipv4('192.168.56.1')],   // VirtualBox, listed first by Windows
    'Wi-Fi': [ipv4('172.20.10.5')],         // the network everyone else is on
  });
  assert.equal(ranked[0], '172.20.10.5');
});

test('virtual adapters are ranked last, not discarded', () => {
  const ranked = rankLocalIPv4({
    'Ethernet 2': [ipv4('192.168.56.1')],
    'Wi-Fi': [ipv4('172.20.10.5')],
  });
  // Kept, because the settings screen lists every address with its own QR and
  // that is how someone recovers when the ranking guesses wrong.
  assert.deepEqual(ranked, ['172.20.10.5', '192.168.56.1']);
});

test('a machine with only a virtual adapter still reports it', () => {
  const ranked = rankLocalIPv4({
    'VirtualBox Host-Only Network': [ipv4('192.168.56.1')],
  });
  assert.deepEqual(ranked, ['192.168.56.1'], 'something reachable beats nothing');
});

test('adapters are recognised by name as well as by subnet', () => {
  for (const name of ['VMware Network Adapter VMnet1', 'vEthernet (Default Switch)', 'Docker Desktop']) {
    const ranked = rankLocalIPv4({
      [name]: [ipv4('10.0.75.1')],          // a subnet the list does not know
      'Wi-Fi': [ipv4('192.168.1.20')],
    });
    assert.equal(ranked[0], '192.168.1.20', `${name} must not win`);
  }
});

test('loopback and link-local never reach a QR code', () => {
  const ranked = rankLocalIPv4({
    'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true } as os.NetworkInterfaceInfo],
    'Wi-Fi': [ipv4('169.254.11.9'), ipv4('192.168.1.20')],
  });
  assert.deepEqual(ranked, ['192.168.1.20']);
});

test('no usable adapter yields no addresses, and callers fall back', () => {
  assert.deepEqual(rankLocalIPv4({}), []);
});

test('ordinary LAN ranges are never mistaken for virtual ones', () => {
  for (const address of ['192.168.1.20', '192.168.0.50', '10.0.0.5', '172.20.10.5', '172.16.4.4']) {
    assert.equal(rankLocalIPv4({ 'Wi-Fi': [ipv4(address)] })[0], address, `${address} is a real LAN address`);
  }
});

test('order within a group follows the OS, since nothing better is available', () => {
  const ranked = rankLocalIPv4({
    'Ethernet': [ipv4('10.0.0.5')],
    'Wi-Fi': [ipv4('192.168.1.20')],
  });
  assert.deepEqual(ranked, ['10.0.0.5', '192.168.1.20']);
});
