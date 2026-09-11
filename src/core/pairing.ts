import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
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
  private codeHash: Buffer;
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
    this.randomToken =
      options.randomToken ?? (() => randomBytes(32).toString("base64url"));
    this.pairingCode = options.randomCode?.() ?? createPairingCode();
    this.codeHash = digest(this.pairingCode);
    this.codeExpiresAt =
      this.now() + (options.codeTtlMilliseconds ?? 5 * 60 * 1000);
    this.capabilities = new Set(options.capabilities);
  }

  private readonly capabilities: ReadonlySet<string>;

  public pair(code: string): { token: string; expiresAt: number } {
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
    const candidate = digest(code);
    if (!timingSafeEqual(candidate, this.codeHash)) {
      throw new CapabilityError(
        401,
        "invalid_pairing_code",
        "Invalid pairing code.",
      );
    }

    this.codeExpiresAt = 0;
    this.codeHash.fill(0);
    const token = this.randomToken();
    const expiresAt = this.now() + this.sessionTtlMilliseconds;
    this.sessions.set(tokenDigest(token), {
      expiresAt,
      principal: {
        id: "local-paired-client",
        capabilities: this.capabilities,
      },
    });
    return { token, expiresAt };
  }

  public authenticate(token: string): CapabilityPrincipal {
    const key = tokenDigest(token);
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

function createPairingCode(): string {
  return randomInt(0, 100_000_000).toString().padStart(8, "0");
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
