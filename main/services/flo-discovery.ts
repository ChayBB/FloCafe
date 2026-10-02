/**
 * Finding a FloCafe POS on the shop network.
 *
 * The app already advertises itself over mDNS (see `startMdns()` in
 * main/index.ts). This is the other half: how a companion device — a second
 * till, a tablet, a KDS screen — locates it without anyone typing an IP.
 *
 * Two records are published for the same server:
 *
 *   `_flo-pos._tcp`  the one to browse. Only FloCafe answers it.
 *   `_http._tcp`     kept for anything that already looks for it.
 *
 * Browsing `_http._tcp` means sifting through every printer, NAS and router on
 * the LAN and guessing which is ours from its TXT keys. The dedicated type
 * removes the guessing; the generic one stays because dropping it would break
 * clients that already rely on it.
 */
import * as os from 'os';
import { Bonjour, type Service } from 'bonjour-service';

/** Service type, without the leading underscore — bonjour-service adds it. */
export const FLO_SERVICE_TYPE = 'flo-pos';

/** Legacy advertisement, still published so existing clients keep working. */
export const FLO_LEGACY_SERVICE_TYPE = 'http';

/**
 * Advertised name.
 *
 * Includes the machine name because mDNS names must be unique on a network: two
 * tills both called "Flo" collide, and the loser is silently renamed to
 * "Flo (2)" — recoverable, but it makes the two indistinguishable in a picker
 * at exactly the moment you need to tell them apart.
 */
export function floServiceName(): string {
  const machine = os.hostname().replace(/\.local$/i, '').trim();
  return machine ? `Flo POS (${machine})` : 'Flo POS';
}

export type FloTxtRecord = {
  version: string;
  api: string;
  kds_port: string;
  server_app_port: string;
};

/**
 * TXT payload. Every value must be a string: mDNS TXT records carry bytes, and
 * a number here is silently stringified by one implementation and dropped by
 * another.
 */
export function floTxtRecord(input: {
  version: string;
  kdsPort: number;
  serverAppPort: number;
}): FloTxtRecord {
  return {
    version: String(input.version),
    api: '/api',
    kds_port: String(input.kdsPort),
    server_app_port: String(input.serverAppPort),
  };
}

export type FloInstance = {
  /** As advertised, e.g. `Flo POS (till-01)`. */
  name: string;
  /** mDNS hostname, e.g. `flo.local`. Present but rarely the right thing to dial. */
  host: string;
  addresses: string[];
  port: number;
  version: string;
  apiUrl: string;
  kdsUrl: string | null;
  serverAppUrl: string | null;
};

/**
 * Picks the address to actually connect to.
 *
 * An IPv4 literal is preferred over the `.local` hostname: resolving mDNS names
 * needs a resolver on the client, which Android and plenty of corporate
 * networks do not have. The hostname is the fallback rather than the default.
 */
function dialableAddress(service: Service): string | null {
  const ipv4 = service.addresses?.find((address) => address.includes('.') && !address.includes(':'));
  if (ipv4) return ipv4;
  const ipv6 = service.addresses?.find((address) => address.includes(':'));
  if (ipv6) return `[${ipv6}]`;
  return service.host || null;
}

/**
 * Converts a discovered service into something dialable, or null when it is not
 * a FloCafe POS.
 *
 * The TXT check matters when browsing the legacy `_http._tcp` type, where every
 * HTTP service on the network turns up.
 */
export function toFloInstance(service: Service): FloInstance | null {
  const txt = (service.txt ?? {}) as Partial<FloTxtRecord>;
  const isFlo = service.type === FLO_SERVICE_TYPE || Boolean(txt.kds_port && txt.server_app_port);
  if (!isFlo) return null;

  const address = dialableAddress(service);
  if (!address || !service.port) return null;

  const portOf = (value: string | undefined): string | null => {
    const port = Number(value);
    return Number.isInteger(port) && port > 0 && port < 65536 ? String(port) : null;
  };
  const kdsPort = portOf(txt.kds_port);
  const serverAppPort = portOf(txt.server_app_port);

  return {
    name: service.name,
    host: service.host,
    addresses: service.addresses ?? [],
    port: service.port,
    version: txt.version ?? 'unknown',
    apiUrl: `http://${address}:${service.port}`,
    kdsUrl: kdsPort ? `http://${address}:${kdsPort}` : null,
    serverAppUrl: serverAppPort ? `http://${address}:${serverAppPort}` : null,
  };
}

/**
 * Decides when a discovered service is news and when it is the same server
 * arriving twice.
 *
 * One POS publishes under both service types with *different names* (`Flo POS
 * (till-01)` and the legacy `Flo`), so identity is the address it answers on,
 * not the advertised name — keyed by name, a picker lists the same till twice.
 * The names behind each address are tracked so a `down` for one record does not
 * retire a server the other record still says is up.
 *
 * Separated from the browsers so it can be tested without real multicast.
 */
export function createInstanceTracker() {
  const namesByUrl = new Map<string, Set<string>>();

  return {
    /** Returns the instance when it is newly seen, or null when already known. */
    up(serviceName: string, instance: FloInstance): FloInstance | null {
      const names = namesByUrl.get(instance.apiUrl);
      if (names) {
        names.add(serviceName);
        return null;
      }
      namesByUrl.set(instance.apiUrl, new Set([serviceName]));
      return instance;
    },

    /** Returns the address that is now gone, or null if it is still advertised. */
    down(serviceName: string): string | null {
      for (const [url, names] of namesByUrl) {
        if (!names.delete(serviceName)) continue;
        if (names.size > 0) return null;
        namesByUrl.delete(url);
        return url;
      }
      return null;
    },

    get size(): number {
      return namesByUrl.size;
    },
  };
}

export type DiscoveryHandlers = {
  onFound: (instance: FloInstance) => void;
  onLost?: (name: string) => void;
  onError?: (error: Error) => void;
};

export type WatchOptions = {
  /** Browse the legacy `_http._tcp` type as well. Off by default — it is noisy. */
  includeLegacyType?: boolean;
  /**
   * How often to re-query. A POS that was asleep or offline when the browser
   * started never announces itself again on its own, so without this a client
   * that opened first simply never sees it.
   */
  refreshMs?: number;
};

const DEFAULT_REFRESH_MS = 30_000;

/** Watches the network for FloCafe instances. Returns a function that stops it. */
export function watchForFlo(handlers: DiscoveryHandlers, options: WatchOptions = {}): () => void {
  const bonjour = new Bonjour(undefined, (error: unknown) => {
    handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
  });

  const types = [FLO_SERVICE_TYPE, ...(options.includeLegacyType ? [FLO_LEGACY_SERVICE_TYPE] : [])];

  const tracker = createInstanceTracker();

  const browsers = types.map((type) => {
    const browser = bonjour.find({ type, protocol: 'tcp' });

    browser.on('up', (service) => {
      const instance = toFloInstance(service);
      if (!instance) return;
      const fresh = tracker.up(service.name, instance);
      if (fresh) handlers.onFound(fresh);
    });

    browser.on('down', (service) => {
      if (tracker.down(service.name)) handlers.onLost?.(service.name);
    });

    return browser;
  });

  const refresh = setInterval(
    () => { for (const browser of browsers) browser.update(); },
    options.refreshMs ?? DEFAULT_REFRESH_MS,
  );

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(refresh);
    for (const browser of browsers) {
      try { browser.stop(); } catch { /* already torn down */ }
    }
    try { bonjour.destroy(); } catch { /* already torn down */ }
  };
}

/**
 * One-shot lookup with a deadline, for a "find my POS" button.
 *
 * Resolves to null rather than rejecting when nothing answers: on a network
 * with multicast disabled that is the normal outcome, not an error, and the
 * caller's next step is the same either way — offer the QR or a manual address.
 */
export function findFloOnce(timeoutMs = 5_000, options: WatchOptions = {}): Promise<FloInstance | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (instance: FloInstance | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      resolve(instance);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    const stop = watchForFlo({ onFound: (instance) => finish(instance) }, options);
  });
}

/** Every instance that answers within the window, for a picker with more than one till. */
export function findAllFlo(timeoutMs = 5_000, options: WatchOptions = {}): Promise<FloInstance[]> {
  return new Promise((resolve) => {
    const found: FloInstance[] = [];
    const stop = watchForFlo({ onFound: (instance) => found.push(instance) }, options);
    setTimeout(() => {
      stop();
      resolve(found);
    }, timeoutMs);
  });
}
