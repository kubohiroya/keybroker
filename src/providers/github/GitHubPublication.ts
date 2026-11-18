import { generateCodeChallenge, generateCodeVerifier } from "./pkce.js";
import {
  getGitAuthSettings,
  hashGitTicket,
  parseGitRemote,
  publicationApprovalPathPattern,
} from "./GitSession.js";
import {
  type Authority,
  approvalTtl,
  approvedTtl,
  authorizePublication,
  canRun,
  denied,
  features,
  type Intent,
  invalid,
  type Job,
  type PublicationCapability,
  type PublicationEnv,
  PublicationError,
  remoteOf,
  type Session,
  type StackParent,
  sameRemote,
  type Target,
  tokenPattern,
  uuidPattern,
  validateIntentShape,
} from "./gitHubPublicationProtocol.js";

type RepositoryIdentity = Omit<Target, "id"> & {
  account: Authority["account"];
  origin: string;
};
type Identity = RepositoryIdentity & { id: string };
type RecordEntry = {
  identity: Identity;
  intent: Intent;
  ticket?: { hash: string; expiresAt: number };
  oauthState?: string;
  verifiedProofHash?: string;
  approvedUntil?: number;
  job?: Job;
};
type RequestBody = {
  identity: Identity;
  session: Session;
  intent: unknown;
  ticket: string;
  id: string;
  objectId: string;
  proofHash: string;
  state: string;
  accountId: number;
  repositoryId: number;
  returnPath: string;
  number: number;
  retryRejectedMerge?: boolean;
};
type Port = {
  branchOid(branch: string): Promise<string | null>;
  pushCommit(oid: string, ref: string): Promise<void>;
  createPullRequest(draft: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<unknown>;
  stackParent?(number: number): Promise<StackParent | null>;
};

export type PublicationEngine = {
  validateIntent(input: unknown): Intent;
  createHost(options: {
    remote: string;
    repositoryId: number;
    grant(
      capability: PublicationCapability,
    ): Promise<{ repositoryId: number; accessToken: string } | null>;
    pushCommit: Port["pushCommit"];
  }): Port;
  createQueue(options: {
    repository: { remote: string; id: number };
    journal: {
      exclusive<T>(key: string, action: () => Promise<T>): Promise<T>;
      get(key: string): Promise<Job | undefined>;
      put(key: string, job: Job): Promise<void>;
    };
    port: Port;
  }): {
    advance(id: string, options: { retryRejectedMerge: boolean }): Promise<Job>;
  };
};

function sameIdentity(left: Identity, right: Identity) {
  return (
    left.id === right.id &&
    left.account.id === right.account.id &&
    left.origin === right.origin &&
    left.repositoryId === right.repositoryId &&
    sameRemote(left.remote, right.remote)
  );
}

function approvalStatus(entry: RecordEntry) {
  if (entry.approvedUntil && entry.approvedUntil > Date.now())
    return "approved";
  if (entry.ticket && entry.ticket.expiresAt > Date.now()) return "pending";
  return "expired";
}

function missingApproval() {
  return new PublicationError(410, "APPROVAL_EXPIRED");
}

/** Each instance is keyed by the immutable account and repository IDs. Its job journal holds no provider token. */
export class GitHubPublication {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: PublicationEnv,
    private readonly engine: PublicationEngine,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const run = this.tail.then(() => this.route(request));
    this.tail = run.catch(() => {});
    try {
      return Response.json(await run);
    } catch (error) {
      const failure =
        error instanceof PublicationError
          ? error
          : new PublicationError(502, "UPSTREAM_FAILURE");
      return Response.json({ code: failure.code }, { status: failure.status });
    }
  }

  private async route(request: Request) {
    const url = new URL(request.url);
    if (
      url.origin !== "https://github-publication.internal" ||
      url.search ||
      request.method !== "POST"
    )
      throw invalid();
    const enabled = features(this.env.GIT_PUBLICATION);
    if (!enabled) throw new PublicationError(404, "PUBLICATION_UNAVAILABLE");
    const input = await request.json<RequestBody>();
    if (url.pathname === "/stack-parent") {
      if (
        !enabled.includes("stacks") ||
        !input.identity ||
        !Number.isSafeInteger(input.number) ||
        input.number < 1 ||
        input.number > 2_147_483_647
      )
        throw denied();
      const authority = await this.authorize(input.identity, input.session);
      const host = this.host(
        input.identity,
        input.session,
        enabled,
        authority,
        async () => {
          throw denied();
        },
      );
      return { parent: (await host.stackParent?.(input.number)) ?? null };
    }
    const id = input.id ?? input.identity?.id;
    if (!id || !uuidPattern.test(id)) throw invalid();
    const key = "job/" + id;
    const entry = await this.state.storage.get<RecordEntry>(key);

    if (url.pathname === "/verify") {
      if (
        !entry ||
        !entry.ticket ||
        entry.ticket.expiresAt <= Date.now() ||
        !entry.oauthState ||
        entry.oauthState !== input.state ||
        entry.identity.account.id !== input.accountId ||
        entry.identity.repositoryId !== input.repositoryId ||
        !/^[0-9a-f]{64}$/u.test(input.proofHash)
      )
        throw missingApproval();
      canRun(entry.intent, enabled);
      await this.state.storage.put<RecordEntry>(key, {
        ...entry,
        oauthState: undefined,
        verifiedProofHash: input.proofHash,
      });
      return { ok: true };
    }
    if (
      url.pathname === "/preview" ||
      url.pathname === "/begin-approval" ||
      url.pathname === "/approve"
    ) {
      if (
        !entry ||
        !entry.ticket ||
        entry.ticket.expiresAt <= Date.now() ||
        !tokenPattern.test(input.ticket) ||
        entry.ticket.hash !== (await hashGitTicket(input.ticket))
      )
        throw missingApproval();
      canRun(entry.intent, enabled);
      if (url.pathname === "/begin-approval")
        return this.beginApproval(key, entry, input);
      const verified =
        entry.verifiedProofHash && entry.verifiedProofHash === input.proofHash;
      if (url.pathname === "/preview") {
        return verified
          ? {
              verified: true,
              intent: entry.intent,
              login: entry.identity.account.login,
              job: entry.job,
            }
          : { verified: false };
      }
      if (!verified) throw denied();
      await this.state.storage.put<RecordEntry>(key, {
        ...entry,
        ticket: undefined,
        oauthState: undefined,
        verifiedProofHash: undefined,
        approvedUntil: Date.now() + approvedTtl,
        job: entry.job ?? { intent: entry.intent, status: "queued" },
      });
      return { ok: true };
    }

    const identity = input.identity;
    if (!identity || (entry && !sameIdentity(entry.identity, identity)))
      throw denied();
    if (url.pathname === "/status") {
      if (!entry) return { approval: "missing", job: null };
      const approval = approvalStatus(entry);
      return {
        approval,
        job: approval === "approved" ? entry.job : null,
        intent: entry.intent,
      };
    }
    if (url.pathname === "/prepare")
      return this.prepare(key, input, enabled, entry);
    if (url.pathname !== "/advance") throw invalid();
    if (!entry || approvalStatus(entry) !== "approved" || !entry.job)
      throw new PublicationError(403, "APPROVAL_REQUIRED");
    return this.advance(key, entry, input, enabled);
  }

  private async beginApproval(
    key: string,
    entry: RecordEntry,
    { id, objectId, proofHash, returnPath }: RequestBody,
  ) {
    const returnTarget = publicationApprovalPathPattern.exec(returnPath);
    if (
      entry.verifiedProofHash ||
      returnTarget?.[1] !== objectId ||
      returnTarget?.[2] !== id ||
      !/^[0-9a-f]{64}$/u.test(proofHash)
    )
      throw missingApproval();
    const settings = getGitAuthSettings(this.env);
    const namespace = this.env.GIT_SESSIONS;
    const remote = parseGitRemote(entry.intent.remote);
    if (!settings || !namespace || !remote) throw denied();
    const state = generateCodeVerifier();
    const verifier = generateCodeVerifier();
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.search = new URLSearchParams({
      client_id: settings.clientId,
      redirect_uri: settings.redirectUri,
      state,
      code_challenge: await generateCodeChallenge(verifier),
      code_challenge_method: "S256",
    }).toString();
    const pending = await namespace
      .get(namespace.idFromName(state))
      .fetch("https://git-session.internal/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase: "pending",
          state,
          verifier,
          ticketHash: await hashGitTicket(generateCodeVerifier()),
          origin: new URL(settings.redirectUri).origin,
          remote,
          write: true,
          review: false,
          deadline: entry.ticket?.expiresAt,
          publication: {
            objectId,
            jobId: id,
            proofHash,
            accountId: entry.identity.account.id,
            repositoryId: entry.identity.repositoryId,
            returnPath,
          },
        }),
      });
    if (pending.status !== 204)
      throw new PublicationError(502, "UPSTREAM_FAILURE");
    await this.state.storage.put<RecordEntry>(key, {
      ...entry,
      oauthState: state,
      verifiedProofHash: undefined,
    });
    return { state, authorizationUrl: authorize.href };
  }

  private async authorize(identity: RepositoryIdentity, session: Session) {
    if (!session || session.origin !== identity.origin) throw denied();
    const authority = await authorizePublication(this.env, session);
    if (
      authority.account.id !== identity.account.id ||
      authority.repositoryId !== identity.repositoryId ||
      !sameRemote(remoteOf(authority), identity.remote)
    )
      throw denied();
    return authority;
  }

  private host(
    identity: RepositoryIdentity,
    session: Session,
    enabled: readonly PublicationCapability[],
    authority: Authority,
    pushCommit: Port["pushCommit"],
  ) {
    return this.engine.createHost({
      remote: identity.remote,
      repositoryId: identity.repositoryId,
      pushCommit,
      grant: async (capability) => {
        if (!enabled.includes(capability)) return null;
        // Reverify the live Git session immediately before each upstream write.
        const verified =
          capability === "pulls-write" ||
          capability === "issues-write" ||
          capability === "merge" ||
          capability === "stacks"
            ? await this.authorize(identity, session)
            : authority;
        return {
          repositoryId: verified.repositoryId,
          accessToken: verified.accessToken,
        };
      },
    });
  }

  private async prepare(
    key: string,
    { identity, intent: raw, session, ticket }: RequestBody,
    enabled: readonly PublicationCapability[],
    previous?: RecordEntry,
  ) {
    if (!tokenPattern.test(ticket)) throw invalid();
    validateIntentShape(raw);
    let intent: Intent;
    try {
      intent = this.engine.validateIntent(raw);
    } catch {
      throw invalid();
    }
    if (
      intent.id !== identity.id ||
      intent.repositoryId !== identity.repositoryId ||
      !sameRemote(intent.remote, identity.remote)
    )
      throw denied();
    intent = { ...intent, remote: identity.remote };
    canRun(intent, enabled);
    if (previous && JSON.stringify(previous.intent) !== JSON.stringify(intent))
      throw new PublicationError(409, "PUBLICATION_CHANGED");
    if (previous && approvalStatus(previous) === "approved")
      return { job: previous.job };

    const authority = await this.authorize(identity, session);
    if (!previous?.job) {
      const host = this.host(
        identity,
        session,
        enabled,
        authority,
        async () => {
          throw denied();
        },
      );
      const [base, head] = await Promise.all([
        host.branchOid(intent.base),
        host.branchOid(intent.head),
      ]);
      if (base !== intent.baseOid || head !== null)
        throw new PublicationError(409, "PUBLICATION_CHANGED");
      if (intent.stackParent) {
        const approved = intent.stackParent;
        const current = await host.stackParent?.(approved.number);
        if (
          !current ||
          current.number !== approved.number ||
          current.head !== approved.head ||
          current.headOid !== approved.headOid ||
          current.targetBase !== approved.targetBase ||
          current.stackNumber !== approved.stackNumber
        )
          throw new PublicationError(409, "PUBLICATION_CHANGED");
      }
    }
    await this.state.storage.put<RecordEntry>(key, {
      identity,
      intent,
      job: previous?.job,
      ticket: {
        hash: await hashGitTicket(ticket),
        expiresAt: Date.now() + approvalTtl,
      },
    });
    return { job: null };
  }

  private async advance(
    key: string,
    entry: RecordEntry,
    input: RequestBody,
    enabled: readonly PublicationCapability[],
  ) {
    const { identity, intent } = entry;
    canRun(intent, enabled);
    const authority = await this.authorize(identity, input.session);
    let awaitingPush = false;
    const host = this.host(
      identity,
      input.session,
      enabled,
      authority,
      async (oid, ref) => {
        if (oid !== intent.commitOid || ref !== "refs/heads/" + intent.head)
          throw denied();
        awaitingPush = true;
        throw new PublicationError(409, "LOCAL_PUSH_REQUIRED");
      },
    );
    const port = {
      ...host,
      async createPullRequest(draft: Parameters<Port["createPullRequest"]>[0]) {
        const [base, head] = await Promise.all([
          host.branchOid(intent.base),
          host.branchOid(intent.head),
        ]);
        if (
          base !== intent.baseOid ||
          head !== intent.commitOid ||
          draft.base !== intent.base ||
          draft.head !== intent.head
        )
          throw denied();
        return host.createPullRequest(draft);
      },
    };
    const queue = this.engine.createQueue({
      repository: { remote: identity.remote, id: identity.repositoryId },
      port,
      journal: {
        // All routes already run under the Durable Object's single operation lock.
        exclusive: (_key, action) => action(),
        get: async () => entry.job,
        put: async (_key, job) => {
          entry.job = awaitingPush ? { ...job, pause: undefined } : job;
          await this.state.storage.put(key, entry);
        },
      },
    });
    const job = await queue.advance(identity.id, {
      retryRejectedMerge: input.retryRejectedMerge === true,
    });
    return awaitingPush
      ? { ...job, pause: undefined, awaitingPush: true }
      : job;
  }
}
