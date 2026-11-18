import { CapabilityError } from "./errors.js";
import type { CapabilityPrincipal } from "./types.js";

export interface PairingManagerOptions {
  capabilities: readonly string[];
  codeTtlMilliseconds?: number;
  sessionTtlMilliseconds?: number;
  maximumAttempts?: number;
  now?: () => number;
  randomCode?: () => string;
  randomToken?: () => string;
}

interface SessionRecord {
  expiresAt: number;
  principal: CapabilityPrincipal;
}

export class PairingManager {
  private readonly code: Uint8Array;
  private codeExpiresAt: number;
  private attempts = 0;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly now: () => number;
  private readonly sessionTtlMilliseconds: number;
  private readonly maximumAttempts: number;
  private readonly randomToken: () => string;
  public readonly pairingCode: string;

  public constructor(options: PairingManagerOptions) {
    this.now = options.now ?? Date.now;
    this.sessionTtlMilliseconds =
      options.sessionTtlMilliseconds ?? 12 * 60 * 60 * 1000;
    this.maximumAttempts = options.maximumAttempts ?? 5;
    this.randomToken = options.randomToken ?? createSessionToken;
    this.pairingCode = options.randomCode?.() ?? createPairingCode();
    this.code = encoder.encode(this.pairingCode);
    this.codeExpiresAt =
      this.now() + (options.codeTtlMilliseconds ?? 5 * 60 * 1000);
    this.capabilities = new Set(options.capabilities);
  }

  private readonly capabilities: ReadonlySet<string>;

  public async pair(
    code: string,
  ): Promise<{ token: string; expiresAt: number }> {
    if (
      this.now() >= this.codeExpiresAt ||
      this.attempts >= this.maximumAttempts
    ) {
      throw new CapabilityError(
        401,
        "pairing_expired",
        "The pairing code has expired. Restart the relay to get a new code.",
      );
    }
    this.attempts += 1;
    if (!constantTimeEqual(encoder.encode(code), this.code)) {
      throw new CapabilityError(
        401,
        "invalid_pairing_code",
        "Invalid pairing code.",
      );
    }

    this.codeExpiresAt = 0;
    this.code.fill(0);
    const token = this.randomToken();
    const expiresAt = this.now() + this.sessionTtlMilliseconds;
    this.sessions.set(await tokenDigest(token), {
      expiresAt,
      principal: {
        id: "local-paired-client",
        capabilities: this.capabilities,
      },
    });
    return { token, expiresAt };
  }

  public async authenticate(token: string): Promise<CapabilityPrincipal> {
    const key = await tokenDigest(token);
    const session = this.sessions.get(key);
    if (!session || session.expiresAt <= this.now()) {
      this.sessions.delete(key);
      throw new CapabilityError(
        401,
        "invalid_token",
        "Invalid or expired relay token.",
      );
    }
    return session.principal;
  }
}

const encoder = new TextEncoder();
const PAIRING_CODE_RANGE = 100_000_000;
const UINT32_RANGE = 2 ** 32;

function createPairingCode(): string {
  // Rejection sampling keeps the eight digits uniform.
  const limit = UINT32_RANGE - (UINT32_RANGE % PAIRING_CODE_RANGE);
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] ?? limit;
    if (value < limit) {
      return (value % PAIRING_CODE_RANGE).toString().padStart(8, "0");
    }
  }
}

function createSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

async function tokenDigest(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < right.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
