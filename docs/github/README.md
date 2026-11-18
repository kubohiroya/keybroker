# GitHub provider on Cloudflare

These documents describe the GitHub routes that keybroker serves on Cloudflare for TurboWarp Plus Editor. They moved here from hierarchidb (`packages/backend/bff/docs/` at 49feb0e34) as step 3 of [ADR 0001](../adr/0001-cloudflare-host-and-github-provider.ja.md).

In hierarchidb the routes ran in two Workers: a BFF for the login, creation and publication routes, and a Git Worker for the Git Smart HTTP and GitHub API relay. keybroker runs them in one Worker, `src/cloudflare/worker.ts`, with every Durable Object in the same script. In these documents, "the BFF" means the login side of that Worker and "the Git Worker" means its relay side.

| Document                                                                          | Content                                                                            |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [git-smart-http.md](./git-smart-http.md)                                          | Login, session, Git Smart HTTP relay, GitHub API routes, enabling and rolling back |
| [github-app-setup.md](./github-app-setup.md) ([日本語](./github-app-setup.ja.md)) | Creating and configuring the GitHub App                                            |
| [github-repository-creation.md](./github-repository-creation.md)                  | Creating a repository for the signed-in account                                    |
| [github-publication.md](./github-publication.md)                                  | Approved publication jobs (pull requests, CI-gated merge, issues)                  |

The wire contract (paths, request and response shapes, error codes, Bearer format and lifetime) is unchanged from hierarchidb, so the Editor only changes the origins it is built with.
