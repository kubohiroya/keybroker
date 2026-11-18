# GitHub repository creation for TurboWarp Plus Editor

This optional BFF flow implements the personal-account creation path for [TurboWarp Plus Editor #525](https://github.com/kubohiroya/turbowarp-plus-editor/issues/525). The ordinary [Git proxy](./git-smart-http.md) continues to use a separate repository-scoped session.

## Authorization

All routes run on the BFF HTTPS origin. Configure its caller origins in `GIT_ALLOWED_ORIGINS`. The caller holds a login ticket and a creation bearer in memory.

| Route                                                       | Request                                                                                       | Result                                                                                |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `POST /v1/github-create/start`                              | Empty JSON object                                                                             | OAuth authorization URL and an origin-bound `login.<state>.<secret>` ticket           |
| `GET /v1/github-create/callback`                            | GitHub's code and state                                                                       | Plain-text result after consuming state and exchanging the code using PKCE            |
| `GET /v1/github-create/session`                             | Login ticket as Bearer                                                                        | `202` while pending, then `{scope, connection, account, bearer, expiresAt}`           |
| `DELETE /v1/github-create/session`                          | Login ticket as Bearer                                                                        | `204` after revoking the session                                                      |
| `GET /v1/github-create/owners`                              | Creation bearer                                                                               | Authenticated personal owner and allowed visibility options                           |
| `POST /v1/github-create/repos`                              | Creation bearer and `{operationId, owner, name, description, visibility, seedDigest, topics}` | `201` with the verified repository ID, owner, name, visibility, and HTTPS Git remote  |
| `PUT /v1/github-create/repos/<id>/topics`                   | Creation bearer and `{operationId}`                                                           | `204` when the journaled topics are applied to that verified repository               |
| `GET /v1/github-create/operations/<operationId>`            | Creation bearer                                                                               | Recorded status and the verified receipt or a candidate to present for reconciliation |
| `POST /v1/github-create/operations/<operationId>/reconcile` | Creation bearer and the explicitly confirmed `{repositoryId}`                                 | `201` with the verified receipt after checking the candidate again                    |

The creation grant uses `scope: "repository-creation"`, `connection: {mode: "cloudflare", proxyOrigin: <BFF origin>}`, and a `create.<state>.<secret>` bearer. It lasts at most 15 minutes and reauthorization is required after expiry. Upstream user access tokens remain encrypted in the login Durable Object until expiry or revocation. Creation credentials are accepted only by this API. Once creation succeeds, the Editor passes the receipt's HTTPS remote and `repositoryId` to the ordinary Git auth start route, requests write access, and verifies the ID in the resulting session before pushing the first commit.

The initial owner list contains the signed-in personal account. Organization creation requires a separate policy and membership capability check. An owner choice reflects the feature's configured scope. GitHub checks the app and user permissions for each operation.

## Creation receipt and retry

The Durable Object journals the normalized intent per immutable GitHub account ID and operation ID before it calls GitHub. Replaying an unchanged intent returns the stored receipt or failure. If the response is lost, the original request may have succeeded. Its operation remains unknown and replay cannot send another creation request. A recently created repository with the same owner, name and visibility and no branches or tags can be shown as a reconciliation candidate. The Editor must obtain explicit confirmation of the candidate ID before requesting reconciliation. The BFF checks it again before recording the receipt. Topics use the confirmed values from the same journal entry. An ID and visibility check precedes every topic mutation.

The upstream API routes are fixed to GitHub's `/user`, `/user/repos`, `/repos/<owner>/<name>` and its topics, branches, and tags routes. Redirects are rejected and errors are sanitized. The BFF returns no GitHub access token or upstream response body.

## Configuration

Register `GitRepositoryCreation` as a SQLite-backed Durable Object and bind it as `GIT_REPOSITORY_CREATION` in the BFF. Set `GIT_CREATE_CLIENT_ID`, `GIT_CREATE_CLIENT_SECRET`, `GIT_CREATE_REDIRECT_URI` (exactly `https://<bff>/v1/github-create/callback`), and `GIT_CREATE_SESSION_KEY` (32 random bytes as 64 hex digits). Add the callback to the GitHub App. The creation endpoints are unavailable without this configuration.

Grant the GitHub App the **Repository creation: Write** repository permission for personal repository creation. For the separate topics operation, **Administration: Write** must be approved. For initial push through the ordinary Git proxy, its App installation and user need **Contents: Write** on the created repository. [Create a repository](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user) · [Topics endpoint](https://docs.github.com/en/rest/repos/repos#replace-all-repository-topics)

For a live check, deploy the BFF and Git Worker in a test environment and configure both Apps and the Editor origin. Use a disposable GitHub account or repository name and a project whose contents may be uploaded. Sign into the creation App from the Editor, confirm the personal owner and repository visibility, and create the repository. Verify its numeric ID, visibility, description and topics in GitHub. If the ordinary Git App installation uses selected repositories, add the new repository to that installation before signing into the ordinary Git App. After first push, verify the default branch, the converted project files, README and license. Replaying the same operation with its original inputs must return the existing receipt.

To roll back, remove the creation binding or its settings. Leave journal records intact so a later re-enable can reconcile earlier attempts.
