# GitHub App for the TurboWarp Plus Editor Git routes

[日本語](./github-app-setup.ja.md)

The Git routes described in [git-smart-http.md](./git-smart-http.md) reach GitHub through a GitHub App. This guide explains who creates that App and how the operator of a deployment creates and configures it.

## Who creates the App

The operator of the Cloudflare deployment (BFF and Git Worker) creates one App per deployment. People who use the Editor do not create an App; they install the operator's App on their own repositories and authorize it when they connect.

| Role                                                        | Creates an App                 | What they do                                                                     |
| ----------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------- |
| Operator of the BFF and Git Worker                          | Yes, one per deployment        | Create the App as below and configure its client ID and client secret in the BFF |
| Distributor of TurboWarp Plus Desktop                       | Yes (the same App can be used) | Give Desktop the client ID of an App with Device Flow enabled                    |
| User of the public Editor or a distributed Desktop          | No                             | Install the App on their repositories and authorize it when connecting           |
| Self-hoster, or user of a Desktop build without a client ID | Yes                            | Create the App as an operator does                                               |

A GitHub App user access token can act only where all three of these overlap: the permissions granted to the App, the repositories the App is installed on, and the authorizing user's own permissions on those repositories. Sharing one App therefore does not let its users act on each other's repositories. [GitHub App user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)

## Create the App

Create the App in GitHub under **Settings → Developer settings → GitHub Apps → New GitHub App**. For an organization, use the organization's **Settings → Developer settings → GitHub Apps**. [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)

### Basic settings

| Setting                                                | Value                                                                                            | Reason                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub App name                                        | For example `<your App name> (dev)`                                                              | Shown on the authorization and installation pages. A separate App per environment is easier to tell apart                              |
| Homepage URL                                           | Where the Editor is published, for example `https://kubohiroya.github.io/turbowarp-plus-editor/` | Shown on the authorization page                                                                                                        |
| Callback URL                                           | The BFF's `/v1/git-auth/callback`, for example `https://<bff-host>/v1/git-auth/callback`         | Where GitHub returns after login. It must match the BFF's `GIT_GITHUB_REDIRECT_URI` exactly. Add one per environment                   |
| Expire user authorization tokens                       | **On**                                                                                           | The BFF and Desktop require expiring access tokens with refresh tokens. When off, GitHub returns no refresh token and connecting fails |
| Request user authorization (OAuth) during installation | Off                                                                                              | Authorization happens when the user connects                                                                                           |
| Enable Device Flow                                     | **On** when Desktop uses the App                                                                 | Desktop logs in with the device flow                                                                                                   |
| Webhook → Active                                       | **Off**                                                                                          | No webhook is used                                                                                                                     |

### Repository permissions

| Permission     | Value          | Used by                                                                             |
| -------------- | -------------- | ----------------------------------------------------------------------------------- |
| Contents       | Read and write | fetch and pull (read), push (write)                                                 |
| Pull requests  | Read and write | Pull request list, title and body (read), review submission (write)                 |
| Metadata       | Read-only      | Added automatically; used to check the repository ID                                |
| Administration | Read and write | Optional. Renaming the repository when the project is renamed (`repository-rename`) |

Grant no other permission, including account and organization permissions. Administration is needed only for the rename route; without it GitHub refuses only the rename, and the Editor tells the user to approve the permission on the installation (Settings → Applications → Installed GitHub Apps → Configure, or the organization's Settings → GitHub Apps). Without review support, Pull requests can be omitted; GitHub then refuses only the pull request routes, and the Git routes keep working.

A permission added later stays unapplied on each installation until that account approves it. [Modifying a GitHub App registration](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration)

### Where the App can be installed

Choose **Any account** under **Where can this GitHub App be installed?** when users install it on their own accounts. **Only on this account** is enough when only the operator's own user or organization repositories are used.

### Values to keep

- **Client ID** (of the form `Iv23…`): a public value. Configure it as the BFF's `GIT_GITHUB_CLIENT_ID` and give it to Desktop.
- **Client secret**: create it with **Generate a new client secret**. Only the BFF uses it, and GitHub shows it once. Do not write it in a repository, chat or log.
- **Private key**: not used, because the routes do not use installation tokens. Do not create one.

### Configure keybroker

In the keybroker Worker (for example `keybroker-dev`), set the variables `GIT_GITHUB_CLIENT_ID` (the client ID), `GIT_GITHUB_REDIRECT_URI` (the same value as the Callback URL), `GIT_ALLOWED_ORIGINS` and `GIT_PROXY_ORIGIN`. The operator enters the secrets from their own terminal:

```bash
npx wrangler secret put GIT_GITHUB_CLIENT_SECRET --name keybroker-dev
```

```bash
openssl rand -hex 32 | npx wrangler secret put GIT_SESSION_KEY --name keybroker-dev
```

Configure the Git Worker's variables (`GIT_ALLOWED_ORIGINS`, `GIT_PROXY_ORIGIN`, `GIT_GITHUB_API`) and deploy in the order described in [git-smart-http.md](./git-smart-http.md#enable-and-roll-back).

## Troubleshooting

| Symptom                                                                                    | Cause                                                                                 | Fix                                                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Connecting fails right after authorization                                                 | Expire user authorization tokens is off, so no refresh token is returned              | Turn it on                                                              |
| GitHub shows a `redirect_uri` error                                                        | The Callback URL and `GIT_GITHUB_REDIRECT_URI` differ                                 | Set both to the same value                                              |
| The repository is not found or access is denied                                            | The App is not installed on that repository                                           | Install the App and select the repository                               |
| Renaming the project does not rename the repository (`ADMINISTRATION_PERMISSION_REQUIRED`) | Administration is not set, or the installation has not approved the added permission  | Set Administration to Read and write and approve it on the installation |
| Pull requests can be read but reviews cannot be submitted                                  | Pull requests is Read-only, or the installation has not approved the added permission | Set Pull requests to Read and write and approve it on the installation  |
| Desktop login does not start                                                               | Device Flow is off, or Desktop has no client ID                                       | Turn on Device Flow and give Desktop the client ID                      |
