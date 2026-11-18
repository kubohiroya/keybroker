import { afterEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({
  auth: vi.fn(async () => new Response("auth")),
  publication: vi.fn(async () => new Response("publication")),
  creation: vi.fn(async () => new Response("creation")),
  git: vi.fn(async () => new Response("git")),
  github: vi.fn(async () => new Response("github")),
}));

vi.mock("../../src/providers/github/handleGitAuth.js", async (original) => ({
  ...(await original<object>()),
  handleGitAuth: handlers.auth,
}));
vi.mock(
  "../../src/providers/github/handleGitHubPublication.js",
  async (original) => ({
    ...(await original<object>()),
    handleGitHubPublication: handlers.publication,
  }),
);
vi.mock(
  "../../src/providers/github/handleGitRepositoryCreation.js",
  async (original) => ({
    ...(await original<object>()),
    handleGitRepositoryCreation: handlers.creation,
  }),
);
vi.mock("../../src/providers/github/handleGitProxy.js", async (original) => ({
  ...(await original<object>()),
  handleGitProxy: handlers.git,
}));
vi.mock("../../src/providers/github/handleGitHubApi.js", async (original) => ({
  ...(await original<object>()),
  handleGitHubApi: handlers.github,
}));

const { default: worker } = await import("../../src/cloudflare/worker.js");
const base = "https://keybroker.test";

afterEach(() => vi.clearAllMocks());

describe("keybroker Worker", () => {
  it.each([
    ["/v1/git-auth/session", "auth"],
    ["/v1/github-publication/jobs/status", "publication"],
    ["/v1/github-create/owners", "creation"],
    ["/v1/git/owner/repo.git/info/refs?service=git-upload-pack", "git"],
    ["/v1/github/owner/repo/pulls", "github"],
  ])("routes %s to its handler", async (path, body) => {
    const response = await worker.fetch(new Request(base + path), {} as never);
    expect(await response.text()).toBe(body);
  });

  it("returns 404 without CORS headers for any other path", async () => {
    const response = await worker.fetch(
      new Request(base + "/?url=https%3A%2F%2Fgithub.com%2F", {
        headers: { Origin: "https://editor.test" },
      }),
      {} as never,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    for (const handler of Object.values(handlers)) {
      expect(handler).not.toHaveBeenCalled();
    }
  });
});
