import { readFile, stat } from "node:fs/promises";
import { platform } from "node:os";
import type { SesameCredentials } from "../providers/candyhouse/client.js";
import { validateCredentials } from "../providers/candyhouse/client.js";
import {
  DEFAULT_CLIENT_SECRET_TTL_SECONDS,
  DEFAULT_OPENAI_REALTIME_MODEL,
  MODEL_PATTERN,
} from "../providers/openai/provider.js";

const OPENAI_KEYS = new Set([
  "apiKeyEnv",
  "apiKey",
  "model",
  "allowedModels",
  "allowedVoices",
  "clientSecretTtlSeconds",
]);

export interface OpenAIProviderConfig {
  apiKey: string;
  model: string;
  allowedModels: readonly string[];
  allowedVoices?: readonly string[];
  clientSecretTtlSeconds: number;
}

export interface RelayConfig {
  server: {
    port: number;
    commandsEnabled: boolean;
    allowedOrigins: readonly string[];
    sessionTtlSeconds: number;
  };
  providers: {
    candyhouse?: {
      devices: Readonly<Record<string, SesameCredentials>>;
    };
    openai?: OpenAIProviderConfig;
  };
}

export async function loadRelayConfig(path: string): Promise<RelayConfig> {
  const metadata = await stat(path);
  if (!metadata.isFile())
    throw new TypeError("Relay config path must be a file.");
  if (platform() !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new TypeError(
      "Relay config contains secrets and must not be accessible by group or other users. Run: chmod 600 <config-file>",
    );
  }

  const text = await readFile(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError("Relay config must contain valid JSON.");
  }
  return parseRelayConfig(value);
}

export function parseRelayConfig(
  value: unknown,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RelayConfig {
  const root = record(value, "config");
  const server = root.server === undefined ? {} : record(root.server, "server");
  const providers = record(root.providers, "providers");
  const parsedProviders: RelayConfig["providers"] = {};
  if (providers.candyhouse !== undefined) {
    parsedProviders.candyhouse = parseCandyHouse(providers.candyhouse);
  }
  if (providers.openai !== undefined) {
    parsedProviders.openai = parseOpenAI(providers.openai, environment);
  }
  if (
    parsedProviders.candyhouse === undefined &&
    parsedProviders.openai === undefined
  ) {
    throw new TypeError(
      "At least one provider (candyhouse or openai) must be configured.",
    );
  }

  return {
    server: {
      port: integer(server.port, "server.port", 1, 65_535, 8787),
      commandsEnabled: boolean(
        server.commandsEnabled,
        "server.commandsEnabled",
        false,
      ),
      allowedOrigins: stringArray(
        server.allowedOrigins,
        "server.allowedOrigins",
        ["null", "https://turbowarp.org"],
      ),
      sessionTtlSeconds: integer(
        server.sessionTtlSeconds,
        "server.sessionTtlSeconds",
        60,
        86_400,
        43_200,
      ),
    },
    providers: parsedProviders,
  };
}

function parseCandyHouse(value: unknown): {
  devices: Readonly<Record<string, SesameCredentials>>;
} {
  const candyhouse = record(value, "providers.candyhouse");
  const rawDevices = record(candyhouse.devices, "providers.candyhouse.devices");
  const devices: Record<string, SesameCredentials> = {};

  for (const [alias, rawCredentials] of Object.entries(rawDevices)) {
    const credentials = record(rawCredentials, `device ${alias}`);
    const parsed = {
      apiKey: string(credentials.apiKey, `${alias}.apiKey`),
      uuid: string(credentials.uuid, `${alias}.uuid`),
      secretKey: string(credentials.secretKey, `${alias}.secretKey`),
    };
    validateCredentials(parsed);
    devices[alias] = parsed;
  }
  if (Object.keys(devices).length === 0) {
    throw new TypeError("At least one Candy House device must be configured.");
  }
  return { devices };
}

function parseOpenAI(
  value: unknown,
  environment: Readonly<Record<string, string | undefined>>,
): OpenAIProviderConfig {
  const openai = record(value, "providers.openai");
  for (const key of Object.keys(openai)) {
    if (!OPENAI_KEYS.has(key)) {
      throw new TypeError("providers.openai contains an unsupported field.");
    }
  }
  const hasEnv = openai.apiKeyEnv !== undefined;
  const hasKey = openai.apiKey !== undefined;
  if (hasEnv === hasKey) {
    throw new TypeError(
      "providers.openai requires exactly one of apiKeyEnv or apiKey.",
    );
  }

  let apiKey: string;
  if (hasEnv) {
    const variable = string(openai.apiKeyEnv, "providers.openai.apiKeyEnv");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(variable)) {
      throw new TypeError(
        "providers.openai.apiKeyEnv must be an environment variable name.",
      );
    }
    const fromEnvironment = environment[variable]?.trim();
    if (!fromEnvironment) {
      throw new TypeError(
        `Environment variable ${variable} (providers.openai.apiKeyEnv) is not set.`,
      );
    }
    apiKey = fromEnvironment;
  } else {
    apiKey = string(openai.apiKey, "providers.openai.apiKey").trim();
    if (apiKey.length === 0) {
      throw new TypeError(
        "providers.openai.apiKey must be a non-empty string.",
      );
    }
  }

  const model =
    openai.model === undefined
      ? DEFAULT_OPENAI_REALTIME_MODEL
      : string(openai.model, "providers.openai.model");
  if (!MODEL_PATTERN.test(model)) {
    throw new TypeError("providers.openai.model has an invalid format.");
  }
  const allowedModels = parseAllowedModels(openai.allowedModels, model);

  const config: OpenAIProviderConfig = {
    apiKey,
    model,
    allowedModels,
    clientSecretTtlSeconds: integer(
      openai.clientSecretTtlSeconds,
      "providers.openai.clientSecretTtlSeconds",
      10,
      600,
      DEFAULT_CLIENT_SECRET_TTL_SECONDS,
    ),
  };
  if (openai.allowedVoices !== undefined) {
    const voices = openai.allowedVoices;
    if (
      !Array.isArray(voices) ||
      voices.some(
        (voice) =>
          typeof voice !== "string" || !/^[a-z0-9_-]{1,32}$/u.test(voice),
      )
    ) {
      throw new TypeError(
        "providers.openai.allowedVoices must be an array of voice names (lowercase letters, digits, _ or -).",
      );
    }
    config.allowedVoices = voices as string[];
  }
  return config;
}

function parseAllowedModels(value: unknown, model: string): string[] {
  if (value === undefined) return [model];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || !MODEL_PATTERN.test(item))
  ) {
    throw new TypeError(
      "providers.openai.allowedModels must be a non-empty array of model names (1 to 128 letters, digits, ., :, _ or -).",
    );
  }
  const models = value as string[];
  if (new Set(models).size !== models.length) {
    throw new TypeError(
      "providers.openai.allowedModels must not contain duplicates.",
    );
  }
  if (!models.includes(model)) {
    throw new TypeError(
      `providers.openai.model (${model}) must be listed in providers.openai.allowedModels.`,
    );
  }
  return [...models];
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function boolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean")
    throw new TypeError(`${name} must be boolean.`);
  return value;
}

function integer(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new TypeError(
      `${name} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return Number(value);
}

function stringArray(
  value: unknown,
  name: string,
  fallback: readonly string[],
): readonly string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${name} must be an array of strings.`);
  }
  if (value.includes("*")) {
    throw new TypeError(`${name} must not contain a wildcard origin.`);
  }
  return value;
}
