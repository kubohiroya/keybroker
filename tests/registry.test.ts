import { describe, expect, it, vi } from "vitest";
import { CapabilityRegistry } from "../src/core/registry.js";
import type {
  CapabilityPrincipal,
  CapabilityProvider,
} from "../src/core/types.js";

const principal = (...capabilities: string[]): CapabilityPrincipal => ({
  id: "client",
  capabilities: new Set(capabilities),
});

function provider(overrides: Partial<CapabilityProvider> = {}) {
  return {
    id: "example",
    capabilities: new Set(["example:call", "example:relay", "example:mint"]),
    execute: vi.fn(async () => ({ ok: true })),
    relay: vi.fn(async () => new Response("streamed")),
    mint: vi.fn(async () => ({ value: "short-lived", expiresAt: 60_000 })),
    ...overrides,
  } satisfies CapabilityProvider;
}

describe("CapabilityRegistry", () => {
  it("dispatches each kind with the principal", async () => {
    const example = provider();
    const registry = new CapabilityRegistry([example]);
    const client = principal("example:call", "example:relay", "example:mint");

    await expect(
      registry.execute(
        "example",
        { capability: "example:call", resource: "r" },
        client,
      ),
    ).resolves.toEqual({ ok: true });

    const request = new Request("https://relay.test/stream");
    const response = await registry.relay(
      "example",
      { capability: "example:relay", resource: "r", request },
      client,
    );
    expect(await response.text()).toBe("streamed");
    expect(example.relay).toHaveBeenCalledWith({
      capability: "example:relay",
      resource: "r",
      request,
      principal: client,
    });

    await expect(
      registry.mint(
        "example",
        { capability: "example:mint", resource: "r" },
        client,
      ),
    ).resolves.toEqual({ value: "short-lived", expiresAt: 60_000 });
  });

  it("checks the capability before any kind runs", async () => {
    const example = provider();
    const registry = new CapabilityRegistry([example]);

    await expect(
      registry.mint(
        "example",
        { capability: "example:mint", resource: "r" },
        principal(),
      ),
    ).rejects.toMatchObject({ status: 403, code: "capability_denied" });
    await expect(
      registry.relay(
        "example",
        {
          capability: "example:other",
          resource: "r",
          request: new Request("https://relay.test/"),
        },
        principal("example:other"),
      ),
    ).rejects.toMatchObject({ status: 404, code: "capability_not_found" });
    expect(example.mint).not.toHaveBeenCalled();
    expect(example.relay).not.toHaveBeenCalled();
  });

  it("treats a kind the provider does not offer as an unknown capability", async () => {
    const callOnly: CapabilityProvider = {
      id: "example",
      capabilities: new Set(["example:mint"]),
      execute: async () => ({}),
    };
    const registry = new CapabilityRegistry([callOnly]);

    await expect(
      registry.mint(
        "example",
        { capability: "example:mint", resource: "r" },
        principal("example:mint"),
      ),
    ).rejects.toMatchObject({ status: 404, code: "capability_not_found" });
  });
});
