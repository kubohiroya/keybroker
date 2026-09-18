import { CapabilityError } from "../../core/errors.js";
import type {
  CapabilityProvider,
  CapabilityRequest,
} from "../../core/types.js";
import type { FetchLike } from "../candyhouse/client.js";
import {
  OpenAIRealtimeClient,
  type RealtimeFunctionTool,
  type RealtimeSessionOptions,
} from "./client.js";

export const OPENAI_REALTIME_CLIENT_SECRET = "openai.realtime.client_secret";
export const OPENAI_REALTIME_RESOURCE = "realtime";
export const DEFAULT_OPENAI_REALTIME_MODEL = "gpt-realtime-2.1";
export const DEFAULT_CLIENT_SECRET_TTL_SECONDS = 60;

const MAX_INSTRUCTIONS_LENGTH = 16_384;
const MAX_TOOLS = 32;
const MAX_TOOL_DESCRIPTION_LENGTH = 1024;
const VOICE_PATTERN = /^[a-z0-9_-]{1,32}$/u;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const REQUEST_KEYS = new Set(["session"]);
const SESSION_KEYS = new Set([
  "instructions",
  "voice",
  "outputModalities",
  "tools",
]);
const TOOL_KEYS = new Set(["type", "name", "description", "parameters"]);

export interface OpenAIProviderOptions {
  apiKey: string;
  model?: string;
  allowedVoices?: readonly string[];
  clientSecretTtlSeconds?: number;
  fetcher?: FetchLike;
  timeoutMilliseconds?: number;
}

export interface OpenAIRealtimeClientSecretResult {
  value: string;
  expiresAt: number;
  model: string;
}

export class OpenAIProvider implements CapabilityProvider {
  public readonly id = "openai";
  public readonly capabilities = new Set([OPENAI_REALTIME_CLIENT_SECRET]);
  private readonly client: OpenAIRealtimeClient;
  private readonly model: string;
  private readonly allowedVoices: ReadonlySet<string> | undefined;
  private readonly ttlSeconds: number;

  public constructor(options: OpenAIProviderOptions) {
    this.client = new OpenAIRealtimeClient(
      { apiKey: options.apiKey },
      options.fetcher,
      options.timeoutMilliseconds,
    );
    this.model = options.model ?? DEFAULT_OPENAI_REALTIME_MODEL;
    this.allowedVoices =
      options.allowedVoices === undefined
        ? undefined
        : new Set(options.allowedVoices);
    this.ttlSeconds =
      options.clientSecretTtlSeconds ?? DEFAULT_CLIENT_SECRET_TTL_SECONDS;
  }

  public async execute(request: CapabilityRequest): Promise<unknown> {
    if (request.capability !== OPENAI_REALTIME_CLIENT_SECRET) {
      throw new CapabilityError(
        404,
        "capability_not_found",
        "Unknown capability.",
      );
    }
    if (request.resource !== OPENAI_REALTIME_RESOURCE) {
      throw new CapabilityError(
        404,
        "resource_not_found",
        "Unknown OpenAI resource.",
      );
    }
    const session = parseSessionRequest(request.input, this.allowedVoices);
    let secret;
    try {
      secret = await this.client.createClientSecret(
        { ...session, model: this.model },
        this.ttlSeconds,
      );
    } catch {
      throw new CapabilityError(
        502,
        "upstream_error",
        "The OpenAI client secret request failed.",
      );
    }
    const result: OpenAIRealtimeClientSecretResult = {
      value: secret.value,
      expiresAt: secret.expiresAt,
      model: this.model,
    };
    return result;
  }
}

export function parseSessionRequest(
  input: unknown,
  allowedVoices?: ReadonlySet<string>,
): Omit<RealtimeSessionOptions, "model"> {
  const body = requireRecord(input, "Request body");
  rejectUnknownKeys(body, REQUEST_KEYS, "Request body");
  if (body.session === undefined) return {};
  const session = requireRecord(body.session, "session");
  rejectUnknownKeys(session, SESSION_KEYS, "session");

  const result: {
    instructions?: string;
    voice?: string;
    outputModalities?: readonly ["audio"] | readonly ["text"];
    tools?: readonly RealtimeFunctionTool[];
  } = {};

  if (session.instructions !== undefined) {
    if (
      typeof session.instructions !== "string" ||
      session.instructions.length > MAX_INSTRUCTIONS_LENGTH
    ) {
      throw invalid(
        `session.instructions must be a string of at most ${MAX_INSTRUCTIONS_LENGTH} characters.`,
      );
    }
    result.instructions = session.instructions;
  }

  if (session.voice !== undefined) {
    if (
      typeof session.voice !== "string" ||
      !VOICE_PATTERN.test(session.voice)
    ) {
      throw invalid(
        "session.voice must be 1 to 32 lowercase letters, digits, underscores, or hyphens.",
      );
    }
    if (allowedVoices !== undefined && !allowedVoices.has(session.voice)) {
      throw invalid("session.voice is not allowed by the relay configuration.");
    }
    result.voice = session.voice;
  }

  if (session.outputModalities !== undefined) {
    result.outputModalities = parseOutputModalities(session.outputModalities);
  }

  if (session.tools !== undefined) {
    result.tools = parseTools(session.tools);
  }

  return result;
}

function parseOutputModalities(
  value: unknown,
): readonly ["audio"] | readonly ["text"] {
  if (Array.isArray(value) && value.length === 1) {
    if (value[0] === "audio") return ["audio"];
    if (value[0] === "text") return ["text"];
  }
  throw invalid('session.outputModalities must be ["audio"] or ["text"].');
}

function parseTools(value: unknown): RealtimeFunctionTool[] {
  if (!Array.isArray(value) || value.length > MAX_TOOLS) {
    throw invalid(
      `session.tools must be an array of at most ${MAX_TOOLS} items.`,
    );
  }
  const names = new Set<string>();
  return value.map((item: unknown, index) => {
    const name = `session.tools[${index}]`;
    const tool = requireRecord(item, name);
    rejectUnknownKeys(tool, TOOL_KEYS, name);
    if (tool.type !== "function") {
      throw invalid(`${name}.type must be "function".`);
    }
    if (typeof tool.name !== "string" || !TOOL_NAME_PATTERN.test(tool.name)) {
      throw invalid(
        `${name}.name must be 1 to 64 letters, digits, underscores, or hyphens.`,
      );
    }
    if (names.has(tool.name)) {
      throw invalid(`${name}.name must be unique.`);
    }
    names.add(tool.name);
    const parsed: RealtimeFunctionTool = { type: "function", name: tool.name };
    if (tool.description !== undefined) {
      if (
        typeof tool.description !== "string" ||
        tool.description.length > MAX_TOOL_DESCRIPTION_LENGTH
      ) {
        throw invalid(
          `${name}.description must be a string of at most ${MAX_TOOL_DESCRIPTION_LENGTH} characters.`,
        );
      }
      parsed.description = tool.description;
    }
    if (tool.parameters !== undefined) {
      if (!isRecord(tool.parameters) || tool.parameters.type !== "object") {
        throw invalid(
          `${name}.parameters must be a JSON Schema object with type "object".`,
        );
      }
      parsed.parameters = tool.parameters;
    }
    return parsed;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalid(`${name} must be a JSON object.`);
  }
  return value;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  name: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalid(`${name} contains an unsupported field.`);
    }
  }
}

function invalid(message: string): CapabilityError {
  return new CapabilityError(400, "invalid_input", message);
}
