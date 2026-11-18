import { createGitHubPublicationHost } from "@kubohiroya/turbowarp-plus-editor-git/github-publication-host";
import {
  createPullRequestQueue,
  validatePublicationIntent,
} from "@kubohiroya/turbowarp-plus-editor-git/pull-request-queue";
import {
  GitHubPublication as Publication,
  type PublicationEngine,
} from "../providers/github/GitHubPublication.js";
import type { GitAuthEnv } from "../providers/github/GitSession.js";
import type { PublicationEnv } from "../providers/github/gitHubPublicationProtocol.js";
import type { GitRepositoryCreationEnv } from "../providers/github/gitRepositoryCreationProtocol.js";
import {
  handleGitAuth,
  isGitAuthPath,
} from "../providers/github/handleGitAuth.js";
import {
  handleGitHubApi,
  isGitHubApiPath,
} from "../providers/github/handleGitHubApi.js";
import {
  handleGitHubPublication,
  isGitHubPublicationPath,
} from "../providers/github/handleGitHubPublication.js";
import {
  handleGitProxy,
  isGitProxyPath,
} from "../providers/github/handleGitProxy.js";
import {
  handleGitRepositoryCreation,
  isGitRepositoryCreationPath,
} from "../providers/github/handleGitRepositoryCreation.js";

export { GitRepositoryCreation } from "../providers/github/GitRepositoryCreation.js";
export { GitSession } from "../providers/github/GitSession.js";

/** The bindings and variables of one keybroker Worker. */
export type KeybrokerEnv = GitAuthEnv &
  PublicationEnv &
  GitRepositoryCreationEnv &
  Record<string, unknown>;

const engine: PublicationEngine = {
  createHost: createGitHubPublicationHost,
  createQueue: createPullRequestQueue,
  validateIntent: validatePublicationIntent,
};

/** The publication journal, wired to the TurboWarp Plus Editor Git engine. */
export class GitHubPublication extends Publication {
  public constructor(state: DurableObjectState, env: PublicationEnv) {
    super(state, env, engine);
  }
}

// One Worker serves the login, creation and publication routes and the Git
// relay. Every route is fixed; any other path is 404.
export default {
  async fetch(request: Request, env: KeybrokerEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (isGitAuthPath(pathname)) return handleGitAuth(request, env);
    if (isGitHubPublicationPath(pathname)) {
      return handleGitHubPublication(request, env);
    }
    if (isGitRepositoryCreationPath(pathname)) {
      return handleGitRepositoryCreation(request, env);
    }
    if (isGitProxyPath(pathname)) return handleGitProxy(request, env);
    if (isGitHubApiPath(pathname)) return handleGitHubApi(request, env);
    return Response.json(
      { code: "NOT_FOUND", requestId: crypto.randomUUID() },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  },
};
