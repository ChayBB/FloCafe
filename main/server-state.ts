import os from 'os';

const DEFAULT_PORT = parseInt(process.env.PORT || '3001', 10);
let activePort = DEFAULT_PORT;

export function getServerPort(): number {
  return activePort;
}

export function setServerPort(port: number): void {
  activePort = port;
}

/** Helper to check if an IPv4 address is active and valid (excludes loopback & 169.254.x.x link-local APIPA). */
function isValidLocalIPv4(alias: os.NetworkInterfaceInfo): boolean {
  const isIPv4 = alias.family === 'IPv4' || (alias.family as string | number) === 4;
  if (!isIPv4 || alias.internal) return false;
  const ip = alias.address;
  if (ip.startsWith('169.254.') || ip.startsWith('127.') || ip === '0.0.0.0') {
    return false;
  }
  return true;
}

/**
 * Adapters that exist only inside this machine.
 *
 * A hypervisor or container runtime leaves a host-only adapter behind, and it
 * usually enumerates before the real Wi-Fi card. Handing its address out is
 * worse than handing out nothing: `http://192.168.56.1:3003` answers perfectly
 * from the till and is unreachable from every phone and tablet in the building,
 * so the QR code looks right and simply never loads.
 */
const VIRTUAL_ADAPTER_NAME = /virtualbox|vmware|hyper-v|vethernet|docker|wsl|loopback|npcap|tap-windows|tunnelbear|zerotier/i;

/** Default host-only ranges for the same software, matched when the name is unhelpful. */
const VIRTUAL_SUBNET = [
  '192.168.56.',   // VirtualBox host-only
  '192.168.99.',   // docker-machine
  '172.17.',       // Docker bridge
  '192.168.137.',  // Windows Internet Connection Sharing
];

function isVirtualAdapter(name: string, address: string): boolean {
  return VIRTUAL_ADAPTER_NAME.test(name) || VIRTUAL_SUBNET.some((prefix) => address.startsWith(prefix));
}

/**
 * Every usable IPv4 address, real network cards first.
 *
 * Order is the whole point: callers take the first entry as "the" address for
 * QR codes and the mDNS log line, so a virtual adapter winning that race sends
 * customers and staff to an address that only resolves on the till itself.
 * Within each group the OS order is preserved — there is no better signal
 * available without a route table.
 */
export function rankLocalIPv4(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[] {
  const real: string[] = [];
  const virtual: string[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const alias of interfaces[name] ?? []) {
      if (!isValidLocalIPv4(alias)) continue;
      (isVirtualAdapter(name, alias.address) ? virtual : real).push(alias.address);
    }
  }
  return [...real, ...virtual];
}

function rankedLocalIPv4(): string[] {
  return rankLocalIPv4(os.networkInterfaces());
}

/** Returns the address other devices on the network should use to reach this machine. */
export function getLocalIP(): string {
  return rankedLocalIPv4()[0] ?? '127.0.0.1';
}

/**
 * Every valid non-loopback IPv4 address, real adapters first.
 *
 * Virtual ones are kept rather than dropped: a machine may genuinely have only
 * a host-only adapter, and the settings screen listing every address with its
 * own QR is how someone recovers from a bad guess here.
 */
export function getAllLocalIPs(): string[] {
  const ips = rankedLocalIPv4();
  return ips.length > 0 ? ips : ['127.0.0.1'];
}
