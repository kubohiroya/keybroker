# @kubohiroya/capability-proxy

A localhost-first relay that exposes named capabilities without giving provider credentials to clients. The first provider implements the Candy House SESAME Web API.

The server binds only to `127.0.0.1`, uses one-time local pairing, stores session token hashes only in process memory, rejects arbitrary upstream URLs, and keeps command capabilities disabled by default.

See [README.ja.md](README.ja.md) for setup, API documentation, the security model, and rollback instructions.

## Development

```sh
pnpm install
pnpm check
```

Licensed under MPL-2.0. The initial Candy House client and AES-CMAC implementation were separated from the MPL-2.0 `@kubohiroya/turbowarp-sesame` implementation by the same author.
