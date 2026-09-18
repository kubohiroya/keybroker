import type { FetchLike } from "../candyhouse/client.js";

const CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;
const EPHEMERAL_KEY_PATTERN = /^ek_[\x21-\x7e]{1,4093}$/u;

export interface OpenAIRealtimeCredentials {
  apiKey: string;
}

export interface RealtimeFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface RealtimeSessionOptions {
  model: string;
  instructions?: string;
  voice?: string;
  outputModalities?: readonly ["audio"] | readonly ["text"];
  tools?: readonly RealtimeFunctionTool[];
}

export interface RealtimeClientSecret {
  value: string;
  expiresAt: number;
}

/**
 * Mints OpenAI Realtime ephemeral client secrets. The long-lived API key is
 * sent only to api.openai.com and never appears in errors thrown here.
 */
export class OpenAIRealtimeClient {
  public constructor(
    private readonly credentials: OpenAIRealtimeCredentials,
    private readonly fetcher: FetchLike = fetch,
    private readonly timeoutMilliseconds: number = DEFAULT_TIMEOUT_MILLISECONDS,
  ) {
    if (credentials.apiKey.trim().length === 0) {
      throw new TypeError("OpenAI API key must not be empty.");
    }
  }

  public async createClientSecret(
    session: RealtimeSessionOptions,
    ttlSeconds: number,
  ): Promise<RealtimeClientSecret> {
    const response = await this.fetcher(CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.credentials.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildClientSecretRequest(session, ttlSeconds)),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMilliseconds),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `OpenAI client secret request failed (${response.status}).`,
      );
    }
    let result: unknown;
    try {
      result = JSON.parse(await response.text()) as unknown;
    } catch {
      throw new Error("OpenAI returned an invalid client secret response.");
    }
    return parseClientSecret(result);
  }
}

export function buildClientSecretRequest(
  session: RealtimeSessionOptions,
  ttlSeconds: number,
): Record<string, unknown> {
  const upstreamSession: Record<string, unknown> = {
    type: "realtime",
    model: session.model,
  };
  if (session.instructions !== undefined) {
    upstreamSession.instructions = session.instructions;
  }
  if (session.outputModalities !== undefined) {
    upstreamSession.output_modalities = [...session.outputModalities];
  }
  if (session.voice !== undefined) {
    upstreamSession.audio = { output: { voice: session.voice } };
  }
  if (session.tools !== undefined && session.tools.length > 0) {
    upstreamSession.tools = session.tools.map((tool) => ({ ...tool }));
    upstreamSession.tool_choice = "auto";
  }
  return {
    expires_after: { anchor: "created_at", seconds: ttlSeconds },
    session: upstreamSession,
  };
}

function parseClientSecret(value: unknown): RealtimeClientSecret {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("OpenAI returned an invalid client secret response.");
  }
  const record = value as Record<string, unknown>;
  const secret = record.value;
  const expiresAt = record.expires_at;
  if (typeof secret !== "string" || !EPHEMERAL_KEY_PATTERN.test(secret)) {
    throw new Error("OpenAI returned an invalid client secret value.");
  }
  if (
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0
  ) {
    throw new Error("OpenAI returned an invalid client secret expiry.");
  }
  return { value: secret, expiresAt: expiresAt * 1000 };
}
