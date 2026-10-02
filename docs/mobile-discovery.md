# Finding the POS from a React Native app

Status: **REFERENCE — not built or run in this repository**

There is no mobile app in this repo, so none of the code below has been executed.
The service contract it depends on *is* verified: see `main/services/flo-discovery.ts`
and `npm run test:flo-discovery`, and the mDNS section of [API.md](API.md).

What the POS publishes, and what this code consumes:

| | |
|---|---|
| Service type | `_flo-pos._tcp` (and the legacy `_http._tcp` named `Flo`) |
| Name | `Flo POS (<machine>)` |
| Port | the API port, 3001 by default |
| TXT | `version`, `api`, `kds_port`, `server_app_port` — all strings |

---

## 1. Platform setup

**Do this first.** Both platforms fail *silently* when it is missing: discovery
runs, reports no error, and finds nothing. It looks like a bug in your code.

### iOS

```bash
npx pod-install
```

`ios/<App>/Info.plist`:

```xml
<key>NSLocalNetworkUsageDescription</key>
<string>Finds your FloCafe POS on the shop WiFi.</string>

<key>NSBonjourServices</key>
<array>
  <string>_flo-pos._tcp</string>
  <!-- Only if you also browse the legacy type: -->
  <string>_http._tcp</string>
</array>
```

Since iOS 14 a service type that is not listed here is simply never returned.
The first scan also triggers a system permission prompt; if the user declines,
later scans keep returning nothing with no error, so the UI needs a path that
does not depend on discovery (see the QR fallback below).

### Android

`android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
<uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />

<application
    android:usesCleartextTraffic="true"
    ... >
```

Two separate problems are being solved here:

1. **Multicast is off by default.** `CHANGE_WIFI_MULTICAST_STATE` lets the
   library hold a multicast lock; without it, mDNS replies never reach the app.
2. **Cleartext HTTP is blocked since Android 9.** The POS is plain `http://` on
   the LAN, so without this the *discovery* succeeds and every request
   afterwards fails — which reads like a discovery bug but is not.

`usesCleartextTraffic="true"` permits cleartext to any host, which is blunt. A
network security config is the narrower tool, but it matches on domain names and
cannot express "any private IP range", and LAN addresses are not known ahead of
time. If the app only ever talks to a LAN POS, the blunt flag is the honest
choice; if it also talks to a cloud API over HTTPS, scope it:

```xml
<!-- android/app/src/main/res/xml/network_security_config.xml -->
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="true">flo.local</domain>
    <!-- Add each LAN address you support, or keep the blunt flag instead. -->
  </domain-config>
</network-security-config>
```

---

## 2. The discovery module

```bash
npm install react-native-zeroconf
```

```ts
// src/pos/floDiscovery.ts
import Zeroconf from 'react-native-zeroconf';

export const FLO_SERVICE_TYPE = 'flo-pos';
export const FLO_LEGACY_SERVICE_TYPE = 'http';

export type FloInstance = {
  name: string;
  host: string;
  addresses: string[];
  port: number;
  version: string;
  apiUrl: string;
  kdsUrl: string | null;
  serverAppUrl: string | null;
};

/**
 * TXT values arrive as strings on iOS, but some react-native-zeroconf versions
 * hand back Buffers or base64 on Android. Coerced here rather than at each use,
 * because the failure is a port that reads `[object Object]` and a URL nobody
 * can dial.
 */
function txtString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return String.fromCharCode(...(value as number[]));
  if (typeof value === 'object' && 'data' in (value as any)) {
    return String.fromCharCode(...((value as any).data as number[]));
  }
  return String(value);
}

function portString(value: unknown): string | null {
  const port = Number(txtString(value));
  return Number.isInteger(port) && port > 0 && port < 65536 ? String(port) : null;
}

/**
 * Picks the address to dial.
 *
 * An IPv4 literal beats the `.local` hostname: Android has no mDNS resolver for
 * hostnames, so `http://flo.local:3001` fails there even when discovery just
 * succeeded.
 */
function dialableAddress(service: any): string | null {
  const addresses: string[] = service.addresses ?? [];
  const ipv4 = addresses.find((a) => a.includes('.') && !a.includes(':'));
  if (ipv4) return ipv4;
  const ipv6 = addresses.find((a) => a.includes(':'));
  if (ipv6) return `[${ipv6}]`;
  return service.host || null;
}

/** Converts a resolved service, or null when it is not a FloCafe POS. */
export function toFloInstance(service: any): FloInstance | null {
  const txt = service?.txt ?? {};
  const kdsPort = portString(txt.kds_port);
  const serverAppPort = portString(txt.server_app_port);

  // Browsing the legacy _http._tcp type turns up every printer, NAS and router
  // on the network. The TXT keys are what identify ours.
  const isFlo = service?.type?.includes(FLO_SERVICE_TYPE) || (txt.kds_port && txt.server_app_port);
  if (!isFlo) return null;

  const address = dialableAddress(service);
  if (!address || !service.port) return null;

  return {
    name: service.name,
    host: service.host,
    addresses: service.addresses ?? [],
    port: service.port,
    version: txtString(txt.version) ?? 'unknown',
    apiUrl: `http://${address}:${service.port}`,
    kdsUrl: kdsPort ? `http://${address}:${kdsPort}` : null,
    serverAppUrl: serverAppPort ? `http://${address}:${serverAppPort}` : null,
  };
}

export type DiscoveryHandlers = {
  onFound: (instance: FloInstance) => void;
  onLost?: (name: string) => void;
  onError?: (error: Error) => void;
};

/**
 * Watches the network. Returns a stop function.
 *
 * One POS answers on both service types under *different* names, so identity is
 * the address it answers on — keyed by name, a picker lists the same till
 * twice. This mirrors `createInstanceTracker()` on the server side.
 */
export function watchForFlo(
  handlers: DiscoveryHandlers,
  options: { includeLegacyType?: boolean } = {},
): () => void {
  const zeroconf = new Zeroconf();
  const namesByUrl = new Map<string, Set<string>>();

  zeroconf.on('resolved', (service: any) => {
    const instance = toFloInstance(service);
    if (!instance) return;
    const names = namesByUrl.get(instance.apiUrl);
    if (names) {
      names.add(service.name);
      return;
    }
    namesByUrl.set(instance.apiUrl, new Set([service.name]));
    handlers.onFound(instance);
  });

  zeroconf.on('remove', (name: string) => {
    for (const [url, names] of namesByUrl) {
      if (!names.delete(name)) continue;
      if (names.size > 0) return;   // still advertised by the other record
      namesByUrl.delete(url);
      handlers.onLost?.(name);
      return;
    }
  });

  zeroconf.on('error', (error: Error) => handlers.onError?.(error));

  zeroconf.scan(FLO_SERVICE_TYPE, 'tcp', 'local.');
  // A second scan on the same instance replaces the first, so the legacy type
  // needs its own Zeroconf.
  let legacy: Zeroconf | null = null;
  if (options.includeLegacyType) {
    legacy = new Zeroconf();
    legacy.on('resolved', (service: any) => {
      const instance = toFloInstance(service);
      if (!instance) return;
      const names = namesByUrl.get(instance.apiUrl);
      if (names) { names.add(service.name); return; }
      namesByUrl.set(instance.apiUrl, new Set([service.name]));
      handlers.onFound(instance);
    });
    legacy.scan(FLO_LEGACY_SERVICE_TYPE, 'tcp', 'local.');
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    for (const instance of [zeroconf, legacy]) {
      if (!instance) continue;
      try { instance.stop(); } catch { /* already torn down */ }
      try { instance.removeDeviceListeners(); } catch { /* ditto */ }
    }
  };
}

/** One-shot lookup with a deadline, for a "find my POS" button. */
export function findFloOnce(timeoutMs = 5_000): Promise<FloInstance | null> {
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
    const stop = watchForFlo({ onFound: finish });
  });
}
```

---

## 3. The fallback that you will actually need

mDNS is blocked on a lot of real café networks: guest WiFi with client
isolation, mesh routers that do not forward multicast, enterprise APs. Treat a
failed discovery as normal, not exceptional.

```ts
// src/pos/floFallback.ts
import { NetworkInfo } from 'react-native-network-info';
import type { FloInstance } from './floDiscovery';

/** Confirms an address really is a FloCafe POS before the app commits to it. */
export async function probe(baseUrl: string, timeoutMs = 1_500): Promise<FloInstance | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${baseUrl}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const body = await response.json();
    if (body?.service !== 'Flo Local API') return null;

    // `/api/health` is the only route reachable before sign-in, and it reports
    // the companion ports for exactly this reason — `/api/pos-info` carries the
    // same values but is authenticated, which is too late to be useful here.
    const origin = new URL(baseUrl);
    const sibling = (port: unknown): string | null => {
      const value = Number(port);
      return Number.isInteger(value) && value > 0 && value < 65536
        ? `http://${origin.hostname}:${value}`
        : null;
    };

    return {
      name: 'Flo POS',
      host: baseUrl,
      addresses: [],
      port: Number(origin.port || 80),
      version: body.version ?? 'unknown',
      apiUrl: baseUrl,
      kdsUrl: sibling(body.kds_port),
      serverAppUrl: sibling(body.server_app_port),
    };
  } catch {
    return null;
  }
}

/**
 * Sweeps the phone's own /24 for a POS.
 *
 * 254 parallel probes with a short timeout finish in about a second on a normal
 * LAN. Only /24 — anything wider is slow enough that a user will give up first,
 * and a shop on a larger subnet should use the QR.
 */
export async function scanSubnet(port = 3001): Promise<FloInstance[]> {
  const ip = await NetworkInfo.getIPV4Address();
  if (!ip) return [];
  const prefix = ip.split('.').slice(0, 3).join('.');

  const results = await Promise.all(
    Array.from({ length: 254 }, (_, i) => probe(`http://${prefix}.${i + 1}:${port}`, 800)),
  );
  return results.filter((r): r is FloInstance => r !== null);
}
```

**Order to try: QR → mDNS → subnet sweep → manual entry.** QR first because it
is the only one a network cannot defeat. The POS shows the code on its own
screen; the endpoint behind it (`GET /api/pos-info`, returning `ip_url` and
`qr_data_url`) is authenticated, so the app reads the code with its camera
rather than fetching it.

`/api/health` is the only route reachable without a token, and it reports
`kds_port` and `server_app_port` alongside status, service name and version — so
every discovery path, not just mDNS, yields a complete set of URLs. Nothing is
disclosed that was not already public: both ports are in the unauthenticated
mDNS TXT record, and a port scan finds them in seconds. The services themselves
still demand a staff token.

---

## 4. A hook

```ts
// src/pos/useFloDiscovery.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { watchForFlo, type FloInstance } from './floDiscovery';
import { probe, scanSubnet } from './floFallback';

const SAVED_KEY = 'flo.pos.apiUrl';

export type DiscoveryState = 'idle' | 'searching' | 'sweeping' | 'found' | 'empty' | 'error';

export function useFloDiscovery(mdnsTimeoutMs = 6_000) {
  const [state, setState] = useState<DiscoveryState>('idle');
  const [instances, setInstances] = useState<FloInstance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  /** Reconnects to the till chosen last time, if it is still answering. */
  const resume = useCallback(async (): Promise<FloInstance | null> => {
    const saved = await AsyncStorage.getItem(SAVED_KEY);
    if (!saved) return null;
    const instance = await probe(saved);
    if (instance) {
      setInstances([instance]);
      setState('found');
    }
    return instance;
  }, []);

  const search = useCallback(async () => {
    setError(null);
    setInstances([]);
    setState('searching');

    const seen = new Map<string, FloInstance>();
    stopRef.current = watchForFlo({
      onFound: (instance) => {
        seen.set(instance.apiUrl, instance);
        setInstances([...seen.values()]);
        setState('found');
      },
      onLost: () => { /* keep it listed; a dropped announcement is not a dead till */ },
      onError: (err) => setError(err.message),
    });

    await new Promise((resolve) => setTimeout(resolve, mdnsTimeoutMs));
    stopRef.current?.();
    stopRef.current = null;

    if (seen.size > 0) return;

    // Multicast is blocked often enough that this is a normal branch.
    setState('sweeping');
    const swept = await scanSubnet();
    setInstances(swept);
    setState(swept.length > 0 ? 'found' : 'empty');
  }, [mdnsTimeoutMs]);

  const choose = useCallback(async (instance: FloInstance) => {
    await AsyncStorage.setItem(SAVED_KEY, instance.apiUrl);
  }, []);

  useEffect(() => () => stopRef.current?.(), []);

  return { state, instances, error, search, resume, choose };
}
```

---

## 5. A connection screen

```tsx
// src/pos/ConnectScreen.tsx
import React, { useEffect } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { useFloDiscovery } from './useFloDiscovery';
import type { FloInstance } from './floDiscovery';

export function ConnectScreen({ onConnected }: { onConnected: (flo: FloInstance) => void }) {
  const { state, instances, error, search, resume, choose } = useFloDiscovery();

  useEffect(() => {
    // Silently rejoin the till from last time before showing a picker at all.
    resume().then((saved) => { if (saved) onConnected(saved); else search(); });
  }, [resume, search, onConnected]);

  const select = async (instance: FloInstance) => {
    await choose(instance);
    onConnected(instance);
  };

  if (state === 'searching' || state === 'sweeping') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <ActivityIndicator />
        <Text>{state === 'searching' ? 'Looking for your POS…' : 'Checking the network…'}</Text>
      </View>
    );
  }

  if (state === 'empty') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 }}>
        <Text style={{ fontWeight: '600' }}>No POS found on this network.</Text>
        <Text style={{ textAlign: 'center', color: '#666' }}>
          Scan the QR code on the POS screen, or enter its address by hand.
        </Text>
        <Pressable onPress={search}><Text>Try again</Text></Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, padding: 16 }}>
      {error ? <Text style={{ color: '#b00' }}>{error}</Text> : null}
      <FlatList
        data={instances}
        keyExtractor={(item) => item.apiUrl}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => select(item)}
            style={{ paddingVertical: 14, borderBottomWidth: 1, borderColor: '#eee' }}
          >
            <Text style={{ fontWeight: '600' }}>{item.name}</Text>
            <Text style={{ color: '#666' }}>{item.apiUrl} · v{item.version}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}
```

---

## Things that will bite

- **iOS Simulator does not do mDNS reliably.** Test discovery on a real device,
  on the same WiFi as the POS. A simulator finding nothing proves nothing.
- **Android emulators are on a NAT'd network** and will not see the host's
  services at all. Same advice.
- **Backgrounding.** Both platforms suspend the browser when the app goes to the
  background; rescan on resume rather than trusting a stale list.
- **Two tills.** The name includes the machine name for this reason. Show it —
  `Flo POS (till-01)` is the only thing distinguishing them in a picker.
- **A found POS is not a reachable one.** Client isolation lets multicast
  through while blocking unicast between clients, so discovery can succeed and
  every request still fail. Probe `/api/health` before declaring success, which
  is what `probe()` above is for.
