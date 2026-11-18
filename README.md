# @kubohiroya/keybroker

[日本語](README.ja.md)

A relay that serves only named capabilities from localhost, without giving external API credentials to clients. The providers implement the Candy House SESAME Web API and the issuing of OpenAI Realtime API ephemeral client secrets.

On Cloudflare, it also runs as a Worker that serves GitHub routes for TurboWarp Plus Editor (see [Cloudflare host](#cloudflare-host)).

## Security boundary

- The server listens only on `127.0.0.1`.
- It does not accept arbitrary URLs, arbitrary HTTP headers, or arbitrary Candy House UUIDs.
- The Candy House API key and secret are kept only in the local config file.
- The OpenAI API key is kept only in an environment variable (recommended) or in the config file. The browser only receives a short-lived ephemeral key (`ek_...`).
- On POSIX systems, the config file must have mode `0600`.
- The 8-digit code shown at startup is exchanged for a session token once.
- Session tokens are hashed and held only in memory. They expire when the relay restarts.
- `lock`, `unlock` and `toggle` are disabled by default.
- CORS is not access control. The actual authorization boundary is the Bearer token.

A service on localhost must still consider malicious web pages, DNS rebinding and brute-force attempts. This implementation validates the Host header, restricts Origins and limits pairing attempts.

## Requirements

- Node.js 22.12 or later
- pnpm 11

## Setup

```sh
pnpm install
cp config.example.json config.local.json
chmod 600 config.local.json
```

Configure only the providers you use in `config.local.json`. Both `providers.candyhouse` and `providers.openai` are optional, but at least one is required. The file is not tracked by Git.

### Candy House

Set the device alias, API key, UUID and secret key.

```json
{
  "server": {
    "port": 8787,
    "commandsEnabled": false,
    "allowedOrigins": ["null", "https://turbowarp.org"]
  },
  "providers": {
    "candyhouse": {
      "devices": {
        "front-door": {
          "apiKey": "...",
          "uuid": "...",
          "secretKey": "..."
        }
      }
    }
  }
}
```

### OpenAI Realtime

Passing the OpenAI API key through an environment variable is recommended.

```sh
export OPENAI_API_KEY='sk-...'
```

```json
{
  "server": {
    "port": 8787,
    "allowedOrigins": ["null", "https://turbowarp.org"]
  },
  "providers": {
    "openai": {
      "apiKeyEnv": "OPENAI_API_KEY",
      "model": "gpt-realtime-2.1-mini",
      "allowedModels": ["gpt-realtime-2.1-mini", "gpt-realtime-2.1"],
      "allowedVoices": ["alloy", "marin", "cedar"],
      "clientSecretTtlSeconds": 60
    }
  }
}
```

| Key                      | Required | Default              | Description                                                                                                                              |
| ------------------------ | -------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKeyEnv`              | \*       | -                    | Name of the environment variable that holds the API key. Recommended. If it is unset or empty at startup, the relay exits with an error. |
| `apiKey`                 | \*       | -                    | The API key written directly. Assumes the config file has mode `0600`.                                                                   |
| `model`                  |          | `"gpt-realtime-2.1"` | Default model. Used when a request omits `session.model`.                                                                                |
| `allowedModels`          |          | `[model]`            | Models a client may choose with `session.model`. Must include `model`.                                                                   |
| `allowedVoices`          |          | No restriction       | When set, the request's `voice` must be in this list.                                                                                    |
| `clientSecretTtlSeconds` |          | `60`                 | Lifetime of the ephemeral key in seconds. An integer from 10 to 600.                                                                     |

\* Specify exactly one of `apiKeyEnv` and `apiKey`. Specifying both or neither is a startup error. Unknown keys are also a startup error. The API key value is never written to logs or error messages.

`allowedModels` must be a non-empty array of unique names matching `^[A-Za-z0-9._:-]{1,128}$`. If `model` is not in the list, startup fails. When omitted, it defaults to `[model]`, and clients can then only use the default model. The operator controls cost by choosing which models to allow. `gpt-realtime-2.1-mini` is cheaper than `gpt-realtime-2.1`, so the example makes mini the default and allows the full model only on explicit request.

## Starting and pairing

```sh
pnpm dev -- --config config.local.json
```

Exchange the 8-digit code printed to standard output once, within 5 minutes.

```sh
curl -X POST http://127.0.0.1:8787/v1/pair \
  -H 'Content-Type: application/json' \
  -d '{"code":"12345678"}'
```

Keep the returned `token` in the TurboWarp extension's memory, and send it to each capability API as `Authorization: Bearer <token>`.

## API

```text
GET  /health
POST /v1/pair
GET  /v1/candyhouse/devices/:alias/status
GET  /v1/candyhouse/devices/:alias/history?page=1&length=20
POST /v1/candyhouse/devices/:alias/commands/lock
POST /v1/candyhouse/devices/:alias/commands/unlock
POST /v1/candyhouse/devices/:alias/commands/toggle
POST /v1/openai/realtime/client-secrets
```

A command body may optionally contain `{"history":"TurboWarp"}`. To use the command API, explicitly set `commandsEnabled` to `true` in the config and restart the relay.

All errors use the form `{"error":{"code":"...","message":"..."}}`.

### OpenAI Realtime client secrets

`POST /v1/openai/realtime/client-secrets` issues an OpenAI Realtime API ephemeral client secret to a paired client (capability `openai.realtime.client_secret`). It requires `Authorization: Bearer <token>`. This route alone has a body limit of 65536 bytes (other routes keep 4096 bytes).

Request body (all fields optional; unknown keys return 400 `invalid_input`):

```json
{
  "session": {
    "model": "gpt-realtime-2.1",
    "instructions": "at most 16384 characters",
    "voice": "marin",
    "outputModalities": ["audio"],
    "tools": [
      {
        "type": "function",
        "name": "move_sprite",
        "description": "at most 1024 characters",
        "parameters": { "type": "object", "properties": {} }
      }
    ]
  }
}
```

- `model`: a model name in `allowedModels`. When omitted, the configured `model` is used. A model not in the list returns 400 `invalid_input` with the message `session.model is not allowed by the relay configuration.`; the allowed list is not echoed back, matching `allowedVoices`.
- `voice`: must match `^[a-z0-9_-]{1,32}$`. When `allowedVoices` is set, it must be in that list.
- `outputModalities`: only `["audio"]` or `["text"]`.
- `tools`: at most 32. `type` is `"function"`, and `name` matches `^[A-Za-z0-9_-]{1,64}$` and is unique. `description` and `parameters` are optional. `parameters` is a JSON object with `type: "object"`. `tool_choice: "auto"` is sent only when at least one tool is given.
- The TTL is fixed by the config. Clients cannot set it.

On success (200, `Cache-Control: no-store`):

```json
{
  "data": {
    "value": "ek_...",
    "expiresAt": 1756310470000,
    "model": "gpt-realtime-2.1"
  }
}
```

`data.model` is the model the client secret was actually issued for. `expiresAt` is in Unix epoch milliseconds. The browser uses this `value` to connect directly to the OpenAI Realtime API.

| Status | `code`               | Condition                                                                                         |
| ------ | -------------------- | ------------------------------------------------------------------------------------------------- |
| 400    | `invalid_json`       | The body is not JSON                                                                              |
| 400    | `invalid_input`      | The body failed validation                                                                        |
| 401    | `missing_token`      | No Bearer token                                                                                   |
| 401    | `invalid_token`      | The token is invalid or expired                                                                   |
| 403    | `capability_denied`  | The token lacks the capability                                                                    |
| 403    | `origin_denied`      | The Origin is not in `allowedOrigins`                                                             |
| 403    | `invalid_host`       | The Host header is invalid                                                                        |
| 404    | `provider_not_found` | `providers.openai` is not configured                                                              |
| 413    | `request_too_large`  | The body exceeds 65536 bytes                                                                      |
| 502    | `upstream_error`     | OpenAI returned a non-2xx status, an invalid response, a network error, or a timeout (10 seconds) |

The `upstream_error` message is a generic text only. It never contains the OpenAI response body or the API key.

### Security notes for OpenAI

- The long-lived API key stays inside the relay process and is never sent to the browser. The browser only receives an ephemeral key that expires after `clientSecretTtlSeconds`. Keep the TTL as short as your use allows.
- While it is valid, an ephemeral key can start billable Realtime sessions on its own. Do not save it in logs or project files.
- When calling from a TurboWarp extension, include the origin the extension runs in within `server.allowedOrigins` (`"null"` for sandboxed extensions, `"https://turbowarp.org"` and similar for unsandboxed ones).
- Origin and Host (DNS rebinding) checks also apply to this route. CORS is not authorization; the Bearer token is the authorization boundary.

## Verification

```sh
pnpm check
```

## Rollback

Stopping the relay process immediately invalidates all local sessions. TurboWarp-Sesame can be switched back to Direct mode. The config file and credentials are not deleted automatically. OpenAI ephemeral keys already issued remain valid until `expiresAt`, even after the relay stops.

## Cloudflare host

`@kubohiroya/keybroker/cloudflare` is a Cloudflare Worker that serves GitHub routes for TurboWarp Plus Editor: GitHub App login with server-side token custody, Git Smart HTTP relay, fixed pull request and review calls, repository creation and approved publication. Tokens are stored encrypted in Durable Objects; the browser only holds short-lived, repository-scoped Bearers. Copy `wrangler.toml.template`, set the secrets, and deploy with `pnpm deploy:cloudflare`. See [docs/github](docs/github/README.md) for details, and [ADR 0001](docs/adr/0001-cloudflare-host-and-github-provider.md) for the design.

There are three entry points: `@kubohiroya/keybroker` (core and providers), `@kubohiroya/keybroker/node` (the localhost relay) and `@kubohiroya/keybroker/cloudflare` (the Worker and its Durable Objects).

## License and origin

MPL-2.0. The initial Candy House client and AES-CMAC implementation were separated from the MPL-2.0 implementation in `@kubohiroya/turbowarp-sesame` by the same author.
