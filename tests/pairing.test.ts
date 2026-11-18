import { describe, expect, it } from "vitest";
import { PairingManager } from "../src/core/pairing.js";

describe("PairingManager", () => {
  it("exchanges a one-time code for an in-memory session", async () => {
    let now = 1_000;
    let tokenNumber = 0;
    const pairing = new PairingManager({
      capabilities: ["candyhouse:status"],
      now: () => now,
      randomCode: () => "12345678",
      randomToken: () => `session-token-value-${++tokenNumber}-long-enough`,
      sessionTtlMilliseconds: 10_000,
    });

    const session = await pairing.pair("12345678");
    expect(session.token).toBe("session-token-value-1-long-enough");
    expect((await pairing.authenticate(session.token)).capabilities).toContain(
      "candyhouse:status",
    );
    await expect(pairing.pair("12345678")).rejects.toThrow(/expired/iu);

    now += 10_001;
    await expect(pairing.authenticate(session.token)).rejects.toThrow(
      /expired/iu,
    );
  });

  it("locks pairing after repeated invalid attempts", async () => {
    const pairing = new PairingManager({
      capabilities: [],
      randomCode: () => "12345678",
      maximumAttempts: 2,
    });

    await expect(pairing.pair("00000000")).rejects.toThrow(
      /invalid pairing code/iu,
    );
    await expect(pairing.pair("00000000")).rejects.toThrow(
      /invalid pairing code/iu,
    );
    await expect(pairing.pair("12345678")).rejects.toThrow(/expired/iu);
  });

  it("counts concurrent attempts before any of them settles", async () => {
    const pairing = new PairingManager({
      capabilities: [],
      randomCode: () => "12345678",
      maximumAttempts: 1,
    });

    const results = await Promise.allSettled([
      pairing.pair("00000000"),
      pairing.pair("12345678"),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
  });

  it("creates eight-digit codes and URL-safe session tokens by default", async () => {
    const pairing = new PairingManager({ capabilities: [] });
    expect(pairing.pairingCode).toMatch(/^\d{8}$/u);
    const session = await pairing.pair(pairing.pairingCode);
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });
});
