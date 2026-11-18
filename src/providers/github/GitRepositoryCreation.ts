import { decrypt, encrypt } from "./encryption.js";
import { generateCodeVerifier } from "./pkce.js";
import { hashGitTicket } from "./GitSession.js";
import {
  exchangeCreationCode,
  githubRefusal,
  readGitHubJson,
  sendCreationRequest,
} from "./githubCreationUpstream.js";
import type {
  CreatedRepository,
  CreationIntent,
  CreationSettings,
  GitRepositoryCreationEnv,
} from "./gitRepositoryCreationProtocol.js";
import {
  CreationError,
  creationError,
  getCreationSettings,
  loginName,
  parseCreationIntent,
  positiveId,
  providerToken,
  record,
  repositoryPath,
  sameName,
  validOperationId,
  verifiedRepository,
} from "./gitRepositoryCreationProtocol.js";

const loginKey = "login";
const creationLimit = 15 * 60_000;
const secretPattern = /^[A-Za-z0-9_-]{43}$/u;
const attemptTimeout = 60_000;

type PendingLogin = {
  phase: "pending" | "exchanging" | "failed";
  state: string;
  verifier: string;
  ticketHash: string;
  origin: string;
  deadline: number;
};
type ActiveLogin = Pick<
  PendingLogin,
  "state" | "ticketHash" | "origin" | "deadline"
> & {
  phase: "active";
  credentials: string;
  account: Account;
};
type Login = PendingLogin | ActiveLogin;
type Account = { id: number; login: string };
type Authority = { account: Account; accessToken: string; expiresAt: number };
type Credentials = { accessToken: string; secret: string };
type CredentialRequest = { credential: string; origin: string; state: string };
type CreationRequest = { authority: Authority; intent: unknown };
type OperationRequest = {
  authority: Authority;
  operationId: string;
  repositoryId?: number;
};
type Failure = { status: number; code: string };
type JournalEntry = { intent: CreationIntent; startedAt: number } & (
  | { phase: "creating" | "unknown" }
  | { phase: "refused"; failure: Failure }
  | {
      phase: "created";
      repository: CreatedRepository;
      topics: "pending" | "applied" | { attempt: number };
    }
);
type CompletedEntry = Extract<JournalEntry, { phase: "created" }>;

function journalKey(operationId: string): string {
  if (!validOperationId(operationId))
    return creationError(400, "invalidRequest");
  return "creation:" + operationId;
}

function assertAuthority({ account, accessToken, expiresAt }: Authority): void {
  if (
    !positiveId(account.id) ||
    !loginName(account.login) ||
    !providerToken(accessToken) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now()
  )
    return creationError(401, "denied");
}

function creationResponse(entry: JournalEntry): Response {
  if (entry.phase === "created")
    return Response.json(entry.repository, { status: 201 });
  if (entry.phase === "refused")
    return creationError(entry.failure.status, entry.failure.code);
  return creationError(502, "unknown");
}

function matchingIntent(left: CreationIntent, right: CreationIntent): boolean {
  return (
    sameName(left.owner, right.owner) &&
    sameName(left.name, right.name) &&
    left.description === right.description &&
    left.visibility === right.visibility &&
    left.seedDigest === right.seedDigest &&
    left.topics.join(",") === right.topics.join(",")
  );
}

function receipt(
  entry: JournalEntry,
  repository: CreatedRepository,
): CompletedEntry {
  const { intent, startedAt } = entry;
  return {
    intent,
    startedAt,
    repository,
    phase: "created",
    topics: intent.topics.length ? "pending" : "applied",
  };
}

export class GitRepositoryCreation {
  private key: Promise<CryptoKey> | undefined;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: GitRepositoryCreationEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const config = getCreationSettings(this.env);
    if (!config || request.method !== "POST")
      return Response.json({ code: "unavailable" }, { status: 404 });
    const path = new URL(request.url).pathname;
    try {
      switch (path) {
        case "/start": {
          const pending = await request.json<PendingLogin>();
          await this.state.storage.transaction(async (tx) => {
            if (await tx.get<Login>(loginKey))
              return creationError(409, "invalidRequest");
            await tx.put(loginKey, pending);
            await tx.setAlarm(pending.deadline);
          });
          return new Response(null, { status: 204 });
        }
        case "/callback": {
          const { state, code } = await request.json<{
            state: string;
            code: string | null;
          }>();
          await this.complete(state, code, config);
          return new Response(null, { status: 204 });
        }
        case "/session":
        case "/revoke":
        case "/authorize":
          return await this.session(
            path,
            await request.json<CredentialRequest>(),
            config,
          );
        case "/create":
          return await this.create(await request.json<CreationRequest>());
        case "/topics":
          return await this.topics(await request.json<OperationRequest>());
        case "/inspect":
        case "/reconcile":
          return await this.reconcile(
            path,
            await request.json<OperationRequest>(),
          );
        default:
          return creationError(400, "invalidRequest");
      }
    } catch (error) {
      return error instanceof CreationError
        ? Response.json({ code: error.code }, { status: error.status })
        : Response.json({ code: "upstreamFailure" }, { status: 502 });
    }
  }

  async alarm(): Promise<void> {
    await this.state.storage.transaction(async (tx) => {
      const current = await tx.get<Login>(loginKey);
      if (current && current.deadline <= Date.now()) await tx.delete(loginKey);
    });
  }

  private encryptionKey(config: CreationSettings): Promise<CryptoKey> {
    this.key ??= crypto.subtle.importKey(
      "raw",
      Uint8Array.from(config.key.match(/../gu) ?? [], (part) =>
        Number.parseInt(part, 16),
      ),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    return this.key;
  }

  private async complete(
    state: string,
    code: string | null,
    config: CreationSettings,
  ): Promise<void> {
    const pending = await this.state.storage.transaction(async (tx) => {
      const login = await tx.get<Login>(loginKey);
      if (
        !login ||
        login.phase !== "pending" ||
        login.state !== state ||
        login.deadline <= Date.now()
      )
        return creationError(400, "invalidOAuthState");
      await tx.put(loginKey, {
        ...login,
        phase: code === null ? "failed" : "exchanging",
      });
      return login;
    });
    if (code === null) return;
    try {
      const tokens = await exchangeCreationCode(config, code, pending.verifier);
      const response = await sendCreationRequest("/user", tokens.accessToken);
      const refusal = githubRefusal(response);
      if (refusal) return creationError(refusal.status, refusal.code);
      if (!response.ok) return creationError(502, "upstreamFailure");
      const user = await readGitHubJson(response);
      if (!record(user) || !positiveId(user.id) || !loginName(user.login))
        return creationError(502, "upstreamFailure");
      const account = { id: user.id, login: user.login };
      const deadline = Math.min(tokens.expiresAt, Date.now() + creationLimit);
      const credentials = await encrypt(
        JSON.stringify({
          accessToken: tokens.accessToken,
          secret: generateCodeVerifier(),
        }),
        await this.encryptionKey(config),
      );
      await this.state.storage.transaction(async (tx) => {
        const latest = await tx.get<Login>(loginKey);
        if (
          !latest ||
          latest.phase !== "exchanging" ||
          latest.state !== state ||
          latest.deadline <= Date.now()
        )
          return creationError(401, "denied");
        await tx.put<ActiveLogin>(loginKey, {
          phase: "active",
          state,
          origin: pending.origin,
          ticketHash: pending.ticketHash,
          account,
          deadline,
          credentials,
        });
        await tx.setAlarm(deadline);
      });
    } catch (error) {
      await this.state.storage.transaction(async (tx) => {
        const latest = await tx.get<Login>(loginKey);
        if (latest?.phase === "exchanging" && latest.state === state) {
          await tx.put(loginKey, { ...latest, phase: "failed" });
        }
      });
      throw error;
    }
  }

  private async session(
    path: string,
    value: CredentialRequest,
    config: CreationSettings,
  ): Promise<Response> {
    if (!secretPattern.test(value.credential))
      return creationError(401, "denied");
    const hash =
      path === "/authorize" ? null : await hashGitTicket(value.credential);
    const login = await this.state.storage.transaction(async (tx) => {
      const current = await tx.get<Login>(loginKey);
      if (
        !current ||
        current.origin !== value.origin ||
        current.state !== value.state ||
        (hash !== null && hash !== current.ticketHash)
      )
        return creationError(401, "denied");
      if (path === "/revoke") await tx.delete(loginKey);
      return current;
    });
    if (path === "/revoke") return new Response(null, { status: 204 });
    if (login.deadline <= Date.now() || login.phase === "failed")
      return creationError(401, "denied");
    if (login.phase !== "active") {
      if (path === "/authorize") return creationError(401, "denied");
      return new Response(null, { status: 202 });
    }
    const { accessToken, secret } = JSON.parse(
      await decrypt(login.credentials, await this.encryptionKey(config)),
    ) as Credentials;
    if (path === "/authorize") {
      if (secret !== value.credential) return creationError(401, "denied");
      return Response.json({
        account: login.account,
        accessToken,
        expiresAt: login.deadline,
      });
    }
    return Response.json({
      scope: "repository-creation",
      connection: { mode: "cloudflare", proxyOrigin: config.origin },
      account: { login: login.account.login },
      bearer: "create." + login.state + "." + secret,
      expiresAt: login.deadline,
    });
  }

  private async create({
    authority,
    intent: value,
  }: CreationRequest): Promise<Response> {
    assertAuthority(authority);
    const intent = parseCreationIntent(value);
    if (!sameName(intent.owner, authority.account.login))
      return creationError(403, "insufficientPermission");
    intent.owner = authority.account.login;
    const key = journalKey(intent.operationId);
    const startedAt = Date.now();
    const creating: JournalEntry = { phase: "creating", intent, startedAt };
    const prior = await this.state.storage.transaction(async (tx) => {
      const entry = await tx.get<JournalEntry>(key);
      if (entry) {
        if (!matchingIntent(entry.intent, intent))
          return creationError(409, "invalidRequest");
        return entry;
      }
      await tx.put(key, creating);
      return null;
    });
    if (prior) return creationResponse(prior);

    let entry: JournalEntry = { ...creating, phase: "unknown" };
    try {
      const response = await sendCreationRequest(
        "/user/repos",
        authority.accessToken,
        "POST",
        {
          name: intent.name,
          description: intent.description,
          private: intent.visibility === "private",
          auto_init: false,
        },
      );
      let failure = githubRefusal(response);
      if (response.status === 422) {
        const body = await readGitHubJson(response);
        const conflict =
          record(body) &&
          Array.isArray(body.errors) &&
          body.errors.some(
            (error: unknown) =>
              record(error) &&
              error.field === "name" &&
              typeof error.message === "string" &&
              /already exists/iu.test(error.message),
          );
        failure = conflict
          ? { status: 409, code: "nameConflict" }
          : { status: 422, code: "invalidRequest" };
      }
      if (failure) {
        await response.body?.cancel().catch(() => {});
        entry = { ...creating, phase: "refused", failure };
      } else if (response.status === 201) {
        const repository = verifiedRepository(
          await readGitHubJson(response),
          intent,
        );
        if (repository) entry = receipt(creating, repository);
      } else {
        await response.body?.cancel().catch(() => {});
      }
    } catch {
      // Any outcome without a validated response remains unknown.
    }
    const settled = await this.state.storage.transaction(async (tx) => {
      const current = await tx.get<JournalEntry>(key);
      if (
        !current ||
        current.startedAt !== startedAt ||
        !matchingIntent(current.intent, intent)
      )
        return creationError(409, "unknown");
      if (current.phase !== "creating") return current;
      await tx.put(key, entry);
      return entry;
    });
    return creationResponse(settled);
  }

  private async topics({
    authority,
    operationId,
    repositoryId,
  }: OperationRequest): Promise<Response> {
    assertAuthority(authority);
    const key = journalKey(operationId);
    const attempt = Date.now();
    const entry = await this.state.storage.transaction(async (tx) => {
      const value = await tx.get<JournalEntry>(key);
      if (
        value?.phase !== "created" ||
        !sameName(value.intent.owner, authority.account.login) ||
        value.repository.id !== repositoryId
      )
        return creationError(403, "insufficientPermission");
      if (
        typeof value.topics === "object" &&
        attempt - value.topics.attempt < attemptTimeout
      )
        return creationError(409, "inProgress");
      if (value.topics !== "applied")
        await tx.put(key, { ...value, topics: { attempt } });
      return value;
    });
    if (entry.topics === "applied") return new Response(null, { status: 204 });
    let applied = false;
    try {
      const path = repositoryPath(entry.repository);
      const response = await sendCreationRequest(path, authority.accessToken);
      const refusal = githubRefusal(response);
      if (refusal) return creationError(refusal.status, refusal.code);
      const repository =
        response.ok &&
        verifiedRepository(await readGitHubJson(response), entry.intent);
      if (!repository || repository.id !== repositoryId)
        return creationError(403, "insufficientPermission");
      const updated = await sendCreationRequest(
        path + "/topics",
        authority.accessToken,
        "PUT",
        {
          names: entry.intent.topics,
        },
      );
      const failed = githubRefusal(updated);
      if (failed) return creationError(failed.status, failed.code);
      if (!updated.ok) return creationError(502, "upstreamFailure");
      const result = await readGitHubJson(updated);
      const names = record(result) ? result.names : null;
      if (
        !Array.isArray(names) ||
        names.length !== entry.intent.topics.length ||
        !entry.intent.topics.every((name) => names.includes(name))
      )
        return creationError(502, "upstreamFailure");
      applied = true;
      return new Response(null, { status: 204 });
    } finally {
      await this.state.storage.transaction(async (tx) => {
        const current = await tx.get<JournalEntry>(key);
        if (
          current?.phase === "created" &&
          typeof current.topics === "object" &&
          current.topics.attempt === attempt
        ) {
          await tx.put(key, {
            ...current,
            topics: applied ? "applied" : "pending",
          });
        }
      });
    }
  }

  private async reconcile(
    path: string,
    { authority, operationId, repositoryId }: OperationRequest,
  ): Promise<Response> {
    assertAuthority(authority);
    const key = journalKey(operationId);
    const entry = await this.state.storage.get<JournalEntry>(key);
    if (!entry || !sameName(entry.intent.owner, authority.account.login))
      return creationError(404, "invalidRequest");
    if (entry.phase === "created") {
      if (path === "/reconcile") {
        if (repositoryId !== entry.repository.id)
          return creationError(409, "unknown");
        return creationResponse(entry);
      }
      return Response.json({ status: "created", repository: entry.repository });
    }
    if (entry.phase === "refused") {
      if (path === "/reconcile") return creationResponse(entry);
      return Response.json({ status: "refused", code: entry.failure.code });
    }
    if (
      entry.phase === "creating" &&
      Date.now() - entry.startedAt < attemptTimeout
    ) {
      return path === "/inspect"
        ? Response.json({ status: "unknown", candidate: null })
        : creationError(409, "inProgress");
    }
    const candidate = await this.findCandidate(entry, authority.accessToken);
    if (path === "/inspect")
      return Response.json({ status: "unknown", candidate });
    if (!candidate || candidate.id !== repositoryId)
      return creationError(409, "unknown");
    const resolved = await this.state.storage.transaction(async (tx) => {
      const current = await tx.get<JournalEntry>(key);
      if (!current || !matchingIntent(entry.intent, current.intent))
        return creationError(409, "unknown");
      if (current.phase === "created" && current.repository.id === repositoryId)
        return current;
      if (
        current.phase !== "unknown" &&
        (current.phase !== "creating" ||
          Date.now() - current.startedAt < attemptTimeout)
      )
        return creationError(409, "unknown");
      const created = receipt(current, candidate);
      await tx.put(key, created);
      return created;
    });
    return creationResponse(resolved);
  }

  private async findCandidate(
    entry: JournalEntry,
    accessToken: string,
  ): Promise<CreatedRepository | null> {
    const path = repositoryPath(entry.intent);
    const response = await sendCreationRequest(path, accessToken);
    if (response.status === 404) return null;
    const refusal = githubRefusal(response);
    if (refusal) return creationError(refusal.status, refusal.code);
    if (!response.ok) return creationError(502, "upstreamFailure");
    const body = await readGitHubJson(response);
    if (!record(body) || typeof body.created_at !== "string" || body.size !== 0)
      return null;
    const repository = verifiedRepository(body, entry.intent);
    const createdAt = Date.parse(body.created_at);
    if (
      !repository ||
      !Number.isFinite(createdAt) ||
      createdAt < Math.floor(entry.startedAt / 1000) * 1000 ||
      createdAt > entry.startedAt + 60_000
    )
      return null;
    const empty = await Promise.all(
      ["branches", "tags"].map(async (kind) => {
        const response = await sendCreationRequest(
          path + "/" + kind + "?per_page=1",
          accessToken,
        );
        if (!response.ok) return false;
        const refs = await readGitHubJson(response);
        return Array.isArray(refs) && refs.length === 0;
      }),
    );
    return empty.every(Boolean) ? repository : null;
  }
}
