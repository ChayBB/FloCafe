const DEFAULT_GUEST_PORT = parseInt(process.env.GUEST_PORT || '3004', 10);
let activeGuestPort = DEFAULT_GUEST_PORT;

export function getDefaultGuestPort(): number {
  return DEFAULT_GUEST_PORT;
}

export function getGuestPort(): number {
  return activeGuestPort;
}

export function setGuestPort(port: number): void {
  activeGuestPort = port;
}
