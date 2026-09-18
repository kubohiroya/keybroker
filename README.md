# @kubohiroya/capability-proxy

A localhost-first relay that exposes named capabilities without giving provider credentials to clients. Providers implement the Candy House SESAME Web API and minting of OpenAI Realtime API ephemeral client secrets.

The server binds only to `127.0.0.1`, uses one-time local pairing, stores session token hashes only in process memory, rejects arbitrary upstream URLs, and keeps command capabilities disabled by default.

## OpenAI Realtime provider

The `openai` provider lets a browser client (for example a TurboWarp extension) obtain a short-lived OpenAI Realtime client secret without ever seeing the real API key. Either provider may be configured on its own, or both together.

```sh
export OPENAI_API_KEY='sk-...'
```

```json
{
  "server": { "allowedOrigins": ["null", "https://turbowarp.org"] },
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

- Exactly one of `apiKeyEnv` (recommended) or `apiKey` is required. The key is never logged or returned.
- `model` is the default model used when a client does not request one (defaults to `gpt-realtime-2.1`).
- `allowedModels` lists the models clients may request via `session.model`. It must be a non-empty array of unique names matching `^[A-Za-z0-9._:-]{1,128}$` and must include `model`; when omitted it defaults to `[model]` (clients can then only use the default). The operator controls cost by choosing this list: `gpt-realtime-2.1-mini` is cheaper than `gpt-realtime-2.1`, so the example makes mini the default and allows the full model only on explicit request.
- `clientSecretTtlSeconds` defaults to `60` (integer, 10 to 600); `allowedVoices` is optional.

`POST /v1/openai/realtime/client-secrets` requires `Authorization: Bearer <relay token>` and accepts a JSON body of up to 65536 bytes (other routes keep the 4096-byte limit):

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

All fields are optional; unknown keys are rejected. `model` must be one of `allowedModels` (otherwise `400 invalid_input` with the message `session.model is not allowed by the relay configuration.`; the allowed list is not echoed back, matching `allowedVoices`) and defaults to the configured `model`. `outputModalities` must be `["audio"]` or `["text"]`, `voice` must match `^[a-z0-9_-]{1,32}$` (and `allowedVoices` when set), and at most 32 uniquely named function tools are accepted. On success the relay returns `200` with `Cache-Control: no-store`:

```json
{
  "data": {
    "value": "ek_...",
    "expiresAt": 1756310470000,
    "model": "gpt-realtime-2.1"
  }
}
```

`data.model` is the model the client secret was actually issued for. `expiresAt` is in epoch milliseconds. Errors use `{"error":{"code","message"}}`: `400 invalid_json` / `invalid_input`, `401 missing_token` / `invalid_token`, `403 capability_denied` / `origin_denied` / `invalid_host`, `404 provider_not_found` (openai not configured), `413 request_too_large`, and `502 upstream_error` for any upstream non-2xx, invalid response, network error, or 10-second timeout (the upstream body is never forwarded).

Security notes: the long-lived key stays inside the relay; browsers only receive an ephemeral key that expires after `clientSecretTtlSeconds` (keep it short, and do not persist it). `server.allowedOrigins` must include the origin the TurboWarp extension runs in (`"null"` for sandboxed extensions, `"https://turbowarp.org"` for unsandboxed ones). Origin and Host (DNS rebinding) checks still apply to this route; the Bearer token, not CORS, is the authorization boundary.

See [README.ja.md](README.ja.md) for setup, API documentation, the security model, and rollback instructions.

## Development

```sh
pnpm install
pnpm check
```

Licensed under MPL-2.0. The initial Candy House client and AES-CMAC implementation were separated from the MPL-2.0 `@kubohiroya/turbowarp-sesame` implementation by the same author.
