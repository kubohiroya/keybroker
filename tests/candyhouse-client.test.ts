import { describe, expect, it, vi } from "vitest";
import { SesameClient } from "../src/providers/candyhouse/client.js";

const credentials = {
  apiKey: "test-api-key",
  uuid: "00000000-0000-0000-0000-000000000000",
  secretKey: "00000000000000000000000000000000",
};

describe("SesameClient", () => {
  it("requests status without exposing the secret key", async () => {
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        void init;
        return new Response('{"locked":true}', { status: 200 });
      },
    );
    const client = new SesameClient(credentials, fetcher);

    await expect(client.getStatus()).resolves.toEqual({ locked: true });
    expect(fetcher).toHaveBeenCalledWith(
      "https://app.candyhouse.co/api/sesame2/00000000-0000-0000-0000-000000000000",
      expect.objectContaining({
        headers: { "x-api-key": "test-api-key" },
        redirect: "error",
      }),
    );
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain(
      credentials.secretKey,
    );
  });

  it("creates the expected AES-CMAC signed command", async () => {
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        void init;
        return new Response('{"statusCode":200}', { status: 200 });
      },
    );
    const client = new SesameClient(
      credentials,
      fetcher,
      () => 0x12345678 * 1000,
    );

    await client.sendCommand("lock", "玄関");
    const [, init] = fetcher.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      cmd: 82,
      history: "546E6Zai",
      sign: "955374fb09f2cdef084aeec8bfda344b",
    });
  });
});
