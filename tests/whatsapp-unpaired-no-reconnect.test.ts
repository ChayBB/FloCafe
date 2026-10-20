/**
 * An install with WhatsApp enabled but never paired must not open sockets on its own.
 *
 * Without credentials a socket can only produce a QR code. When nobody scans it,
 * WhatsApp closes the connection with 408 "QR refs attempts ended", and the close
 * handler used to treat that as a transient drop and reconnect five seconds later
 * — which asked for another QR, which also expired. One real till sat at attempt
 * 680, two weeks after the merchant switched the feature on and never finished
 * pairing.
 *
 * Reconnecting is right when credentials exist: that is a paired phone whose
 * connection dropped. Both halves are pinned here, along with the fact that
 * pairing started by the merchant still opens a socket.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Module from 'node:module';

const realLoad = (Module as any)._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-whatsapp-unpaired-'));
const authDir = path.join(testDir, 'whatsapp-auth');

const eventHandlers = new Map<string, (value: any) => void>();
let makeSocketCalls = 0;

const fakeSocket = {
  ev: {
    on: (event: string, handler: (value: any) => void) => {
      eventHandlers.set(event, handler);
    },
  },
  onWhatsApp: async () => [],
  presenceSubscribe: async () => {},
  sendPresenceUpdate: async () => {},
  sendMessage: async () => ({ key: { id: 'unused' } }),
  end: () => {},
};

const fakeBaileys = {
  fetchLatestWaWebVersion: async () => ({ version: [2, 3000, 1] }),
  useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => {} }),
  makeWASocket: () => {
    makeSocketCalls++;
    return fakeSocket;
  },
  Browsers: { macOS: () => ({}) },
  proto: { Message: { create: () => ({}) } },
};

(Module as any)._load = function (request: string, ...rest: any[]) {
  if (request === 'electron') {
    return {
      app: { getPath: () => testDir, getVersion: () => 'test', isPackaged: true },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString(),
      },
    };
  }
  if (request === '../baileys-loader.cjs') return { loadBaileys: async () => fakeBaileys };
  return realLoad.call(this, request, ...rest);
};

const { initTestDb, getDatabase, closeDatabase, now } = require('./helpers/test-setup');
const whatsapp = require('../main/services/whatsapp');

function setEnabled(): void {
  getDatabase()
    .prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    )
    .run('whatsapp_enabled', 'true', now());
}

function writeCredentials(): void {
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(
    path.join(authDir, 'creds.json'),
    JSON.stringify({ me: { id: '15555550100:1@s.whatsapp.net' } }),
  );
}

function removeCredentials(): void {
  fs.rmSync(authDir, { recursive: true, force: true });
}

/** The close WhatsApp sends when a QR goes unscanned. */
function fireQrTimeout(): void {
  const handler = eventHandlers.get('connection.update');
  if (!handler) throw new Error('no connection.update handler registered');
  handler({
    connection: 'close',
    lastDisconnect: {
      error: Object.assign(new Error('QR refs attempts ended'), {
        output: { statusCode: 408 },
      }),
    },
  });
}

const failures: string[] = [];
function assert(condition: unknown, message: string): void {
  if (!condition) failures.push(message);
  console.log(`  ${condition ? '✓' : '✗'} ${message}`);
}

async function settle(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log('WhatsApp: an unpaired install does not reconnect');
  console.log('='.repeat(48));

  try {
    initTestDb();
    setEnabled();

    // --- enabled, never paired: startup opens nothing ---
    removeCredentials();
    makeSocketCalls = 0;
    whatsapp.initFromDb();
    await settle();
    assert(makeSocketCalls === 0, 'startup opens no socket while there are no credentials');
    assert(
      whatsapp.getStatus().state !== 'connecting',
      'and the status does not claim to be connecting',
    );

    // --- the merchant starts pairing: that does open one ---
    const started = await whatsapp.connectWithQr();
    await settle();
    assert(started.ok === true, 'the merchant can still start pairing');
    assert(makeSocketCalls === 1, 'pairing opens exactly one socket');

    // --- nobody scans it: no reconnect is scheduled ---
    fireQrTimeout();
    await settle();
    const afterTimeout = whatsapp.getStatus();
    assert(
      afterTimeout.state === 'disconnected',
      'an unscanned QR leaves the service disconnected, not reconnecting',
    );
    assert(
      afterTimeout.lastErrorReason !== 'reconnecting',
      'and it is not reported as a reconnect',
    );
    // The old loop fired five seconds after the close.
    await settle(5_600);
    assert(makeSocketCalls === 1, 'no second socket is opened after the reconnect delay');

    // --- a paired phone that drops still reconnects ---
    writeCredentials();
    makeSocketCalls = 0;
    await whatsapp.connectWithQr();
    await settle();
    assert(makeSocketCalls === 1, 'a paired install opens its socket');
    fireQrTimeout();
    await settle();
    assert(
      whatsapp.getStatus().lastErrorReason === 'reconnecting',
      'a drop with credentials present is still treated as transient',
    );
    await settle(5_600);
    assert(makeSocketCalls === 2, 'and it reconnects');

    console.log(`\n${failures.length === 0 ? 'All' : 'Some'} assertions evaluated.`);
    if (failures.length > 0) {
      console.error('\nFailures:');
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exit(1);
    }
    console.log('All WhatsApp unpaired-reconnect assertions passed.');
  } finally {
    try {
      whatsapp.disable();
    } catch {
      /* best effort */
    }
    try {
      closeDatabase();
    } catch {
      /* already closed */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('\nTest failed:', error);
  process.exit(1);
});
