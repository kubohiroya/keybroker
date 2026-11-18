# ADR 0001: Add a Cloudflare host and the GitHub and ide-gsm providers to keybroker

[日本語](./0001-cloudflare-host-and-github-provider.ja.md)

- **Status:** Accepted
- **Date:** 2026-11-18

## Context

There are currently two places that implement a credential broker: a mechanism that relays only defined operations without handing credentials to the client.

|                          | keybroker (formerly capability-proxy)                    | hierarchidb BFF and Git Worker                                         |
| ------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| Where it runs            | The user's machine (`127.0.0.1`, Node)                   | Cloudflare Workers and a Durable Object                                |
| Credentials it protects  | The operator's OpenAI API key and Sesame key             | Each user's GitHub access token and refresh token                      |
| Client authentication    | Pairing with a one-time code                             | Login through the GitHub App web flow (PKCE)                           |
| What the client receives | A relay token, an OpenAI ephemeral key                   | A proxy Bearer that expires in 5 minutes                               |
| Relay shape              | JSON request and response (`CapabilityProvider.execute`) | Relaying binary Git Smart HTTP, and calling a fixed set of GitHub APIs |
| Main users               | turbowarp-openai-realtime-api, turbowarp-sesame          | The browser version of TurboWarp Plus Editor                           |

The Git part of hierarchidb has nothing to do with hierarchidb's own features. It was added to hierarchidb's BFF and CORS proxy for TurboWarp Plus Editor (hierarchidb #1754, #1755, #1757, #1761). On the other hand, hierarchidb itself, turbowarp-openai-realtime-api and turbowarp-sesame are also expected to need the same kind of relay in the cloud.

ide-gsm will also use keybroker, to open its GraphQL API to authenticated users. Unlike the existing providers, ide-gsm is not a third-party service but an API that the operator runs. ide-gsm currently works as follows (based on ide-gsm's `api-idegsm`, `api-github` and `api-idegsm/docs/HIERARCHIDB_INTEGRATION_SPEC_ja.md`).

- It serves GraphQL over HTTP, and a WebSocket for subscriptions.
- Authentication uses a JWT (with the `upn` claim) signed by a key that ide-gsm trusts.
- ide-gsm does authorization itself, with each user's workspace as the boundary.
- `api-github` runs GitHub OAuth on its own and holds the user's GitHub token in memory.
- The browser calls it with a Bearer supplied from outside. CORS allows origins by exact match.

Maintaining the two separately means keeping origin checks, short-lived token minting and the restrictions that prevent relaying arbitrary URLs in two places. We therefore move the Git part from hierarchidb into keybroker, and restructure keybroker as a combination of a host (where it runs) and providers (the services it connects to).

### What we move

The following items from hierarchidb main (5d8bcd811) and the unmerged hierarchidb #1760.

| hierarchidb file                                                                 | Role                                                                                                           |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/backend/bff/src/GitSession.ts`                                         | Durable Object. Login state, token encryption and storage, serialized refresh, push ID and review reservations |
| `packages/backend/bff/src/handleGitAuth.ts`                                      | `/v1/git-auth/start`, `callback`, `session`                                                                    |
| `packages/backend/cors-proxy/src/gitWorker.ts`                                   | Git Worker entry point                                                                                         |
| `packages/backend/cors-proxy/src/handleGitProxy.ts`                              | `/v1/git/<owner>/<repo>.git/...` (Git Smart HTTP)                                                              |
| `packages/backend/cors-proxy/src/handleGitHubApi.ts`, `githubReviewDocuments.ts` | `/v1/github/<owner>/<repo>/...` (PRs and reviews)                                                              |
| `GitRepositoryCreation.ts`, `GitHubPublication.ts` and others from #1760         | Repository creation and publishing                                                                             |
| `packages/backend/bff/docs/git-smart-http.md`, `github-app-setup*.md`            | The protocol contract, and how to create the GitHub App                                                        |

We do not move hierarchidb's own login (Google, Microsoft, GitHub OAuth App and KV) or the generic `?url=` proxy.

## Decision

### 1. One package, with an entry point per host

`@kubohiroya/keybroker` stays a single package, with separate entry points.

| Entry point                                          | Contents                                        |
| ---------------------------------------------------- | ----------------------------------------------- |
| `@kubohiroya/keybroker`                              | core (provider types, registry, errors, policy) |
| `@kubohiroya/keybroker/node` and the CLI `keybroker` | The current localhost relay                     |
| `@kubohiroya/keybroker/cloudflare`                   | The Worker `fetch` and the Durable Object class |

core and the providers use only Web standard APIs (Web Crypto, `fetch`, `Request`/`Response`). Today only `src/core/pairing.ts` uses `node:crypto`, so we replace it with Web Crypto. Hono, which we use to build the HTTP layer, runs on Workers as is.

This work also includes renaming the npm package from `@kubohiroya/capability-proxy` to `@kubohiroya/keybroker` (the GitHub repository is already renamed; nothing is published to npm yet).

### 2. Three kinds of capability: call, relay and mint

| Kind             | What it does                                                                                 | Providers that use it                                   |
| ---------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Call (`execute`) | Takes JSON and returns JSON                                                                  | Sesame status, history and operations                   |
| Relay (`relay`)  | Streams to a fixed upstream as is. Also handles WebSocket upgrades                           | GitHub (Git Smart HTTP), ide-gsm (when relay is chosen) |
| Mint (`mint`)    | Mints a short-lived credential usable upstream; the client connects to the upstream directly | OpenAI Realtime ephemeral key, ide-gsm short-lived JWT  |

The current `CapabilityProvider.execute` covers only "call". Git Smart HTTP streams binary data and ide-gsm subscriptions use a WebSocket, so they do not fit. The OpenAI ephemeral key is returned today as the result of `execute`, but it is really a "mint".

```ts
interface CapabilityProvider {
  readonly id: string;
  readonly capabilities: ReadonlySet<string>;
  execute?(request: CapabilityRequest): Promise<unknown>;
  relay?(request: RelayRequest): Promise<Response>;
  mint?(request: CapabilityRequest): Promise<MintedCredential>;
}

interface MintedCredential {
  value: string;
  expiresAt: number;
}
```

For every kind, the provider builds upstream URLs only in the shapes it defines. The invariant that keybroker never accepts an arbitrary URL from the client is shared by all kinds. For "mint", the provider guarantees that the credential is short-lived and has the minimum permissions needed.

### 3. The host can swap "who may use it" and "credential store"

| Component                                     | node host                               | cloudflare host                                                |
| --------------------------------------------- | --------------------------------------- | -------------------------------------------------------------- |
| How the user is identified (principal source) | Pairing (unchanged)                     | Login through the GitHub App web flow (PKCE)                   |
| Per-user credential store                     | None (operator credentials only)        | Durable Object. Encrypts with AES-GCM and serializes refreshes |
| Operator credentials                          | Environment variables and a config file | Workers secrets                                                |

GitHub is a provider that holds the user's own credentials. OpenAI and Sesame are providers that let users use the operator's credentials. ide-gsm is a provider for which keybroker creates per-user credentials on the spot, using the operator's signing key. core treats these differences as combinations of a principal source and a credential store.

When the cloudflare host uses GitHub login, the GitHub provider holds the GitHub App token, which has repository permissions. The ide-gsm provider uses that login only to establish who the user is, and does not use the GitHub token.

### 4. The Cloudflare host runs as a single Worker by default

In hierarchidb, the BFF and the Git Worker were separate Workers, and the Git Worker referenced the BFF's Durable Object. keybroker has no generic proxy alongside it, so by default we combine everything into one Worker and put the Durable Object in the same Worker. This removes the configuration for referencing another Worker's Durable Object, and deployment takes one step.

The Editor build settings `TW_PLUS_GIT_BFF_ORIGIN` and `TW_PLUS_GIT_PROXY_ORIGIN` both point to the same keybroker origin.

### 5. The GitHub provider keeps the current protocol contract as is

We do not change the routes (`/v1/git-auth/*`, `/v1/git/*`, `/v1/github/*`), the request and response shapes, the error codes, or the Bearer format and lifetime. TurboWarp Plus Editor's `turbowarp-plus-editor-auth` and `turbowarp-plus-editor-git` work by only changing the origin they connect to. We also move the tests from hierarchidb and check the same behavior.

### 6. The ide-gsm provider mints short-lived JWTs by default

When a user logs in to keybroker, keybroker mints a JWT that expires in a few minutes, signed with a key that ide-gsm trusts. The browser connects to ide-gsm directly with that JWT. The only change on the ide-gsm side is to register keybroker as a JWT issuer and trust its public key. The heavy simulation traffic and the WebSocket do not pass through Cloudflare.

If ide-gsm cannot be placed where the browser can reach it directly, the operator can instead choose to have keybroker "relay" GraphQL over HTTP and the WebSocket. In that case, the browser holds only a proxy Bearer that expires in 5 minutes.

In both forms, we keep the following.

- **Who gets access:** Mint only for GitHub accounts or organizations that the operator allows.
- **User mapping:** Map each GitHub account to an ide-gsm `upn` and workspace. The operator owns the mapping table.
- **Permission ceiling:** Never mint ide-gsm's `worker` or `admin` roles for browser users.
- **GraphQL restrictions:** ide-gsm authorizes each user itself, so the content of queries is left to ide-gsm. If needed, the provider configuration can hold an allowlist by operation name (ide-gsm's tests forbid duplicate operation names).
- **Out of scope:** MCP (`/mcp/sse`) connections use a different authentication flow, so this provider does not handle them.

### 7. One deployment belongs to one operator

Multi-tenancy (one deployment serving GitHub Apps of several operators) is out of scope. Each operator deploys to their own Cloudflare account. We provide deployment steps and configuration templates so that schools and institutions can run their own.

### 8. The operator explicitly chooses which providers to enable in the cloud

The first provider enabled on the cloudflare host is the GitHub provider. The ide-gsm provider can be enabled once the operator has prepared the user mapping table and the list of allowed accounts, because the upstream is the operator's own API and ide-gsm does the authorization. OpenAI and Sesame become available on the cloudflare host only when needed, and only after the following are in place.

- **OpenAI:** Several users share the operator's API key, so we need user identification and per-user limits on usage and cost.
- **Sesame:** It would be placed where unlocking can be requested from the internet, so remote operations are disabled by default, and restrictions such as lock-only or confirmation-required are designed first.

### 9. The license is MPL-2.0

The code we move lives in hierarchidb (MIT), but the author is the same. We republish it under keybroker's MPL-2.0.

## Migration steps

1. Merge hierarchidb #1760 first, so that we do not move work in progress.
2. keybroker: rename the npm package, move core to Web standard APIs, and add "relay" and "mint" to providers. Do not change the node host's behavior.
3. keybroker: move the cloudflare host and the GitHub provider from hierarchidb main. Move the tests too.
4. Deploy to dev. The operator creates a dev GitHub App with the GitHub account that owns GitHub Apps, and deploys the Worker with the Cloudflare account that deploys Workers. The operator enters secret values themselves.
5. Build TurboWarp Plus Editor against keybroker's dev origin, and check fetch, pull and push against a real private GitHub repository (TurboWarp Plus Editor #316).
6. Remove the Git part and its documents from hierarchidb, and point it to keybroker.
7. Change the links in TurboWarp Plus Editor's documents (GitHub App setup and API setup under `docs/features/git/`) to keybroker.
8. keybroker: add the ide-gsm provider (minting short-lived JWTs). Register keybroker as a JWT issuer in ide-gsm, and use keybroker from hierarchidb's "mechanism that supplies the Bearer".

## Open questions

- Should we keep a configuration that splits the cloudflare host into two Workers: login (holds the client secret) and relay (carries heavy traffic)?
- Should the localhost Git proxy in the TurboWarp Plus Desktop main process move to keybroker's node host and GitHub provider (device flow)?
- How should ide-gsm be placed where Cloudflare can reach it (Cloudflare Tunnel or similar), and should it use JWT minting or relay?
- Should the GitHub OAuth and GitHub API relay that ide-gsm's `api-github` runs on its own move to keybroker's GitHub provider?

## Related

- [TurboWarp Plus Editor #315](https://github.com/kubohiroya/turbowarp-plus-editor/issues/315), [#316](https://github.com/kubohiroya/turbowarp-plus-editor/issues/316)
- [hierarchidb #1760](https://github.com/kubohiroya/hierarchidb/pull/1760), [#1761](https://github.com/kubohiroya/hierarchidb/pull/1761)
- turbowarp-sesame ADR 0001 (the decision to rename capability-proxy to keybroker)
- ide-gsm `api-idegsm/docs/HIERARCHIDB_INTEGRATION_SPEC_ja.md` (the contract for connecting from hierarchidb to ide-gsm)
