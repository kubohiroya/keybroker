import { describe, expect, it } from "vitest";
import { PairingManager } from "../src/core/pairing.js";

describe("PairingManager", () => {
  it("exchanges a one-time code for an in-memory session", () => {
    let now = 1_000;
    let tokenNumber = 0;
    const pairing = new PairingManager({
      capabilities: ["candyhouse:status"],
      now: () => now,
      randomCode: () => "12345678",
      randomToken: () => `session-token-value-${++tokenNumber}-long-enough`,
      sessionTtlMilliseconds: 10_000,
    });

    const session = pairing.pair("12345678");
    expect(session.token).toBe("session-token-value-1-long-enough");
    expect(pairing.authenticate(session.token).capabilities).toContain(
      "candyhouse:status",
    );
    expect(() => pairing.pair("12345678")).toThrow(/expired/iu);

    now += 10_001;
    expect(() => pairing.authenticate(session.token)).toThrow(/expired/iu);
  });

  it("locks pairing after repeated invalid attempts", () => {
    const pairing = new PairingManager({
      capabilities: [],
      randomCode: () => "12345678",
      maximumAttempts: 2,
    });

    expect(() => pairing.pair("00000000")).toThrow(/invalid pairing code/iu);
    expect(() => pairing.pair("00000000")).toThrow(/invalid pairing code/iu);
    expect(() => pairing.pair("12345678")).toThrow(/expired/iu);
  });
});
