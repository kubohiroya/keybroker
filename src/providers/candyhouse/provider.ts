import { CapabilityError } from "../../core/errors.js";
import type {
  CapabilityProvider,
  CapabilityRequest,
} from "../../core/types.js";
import {
  SesameClient,
  type SesameCommand,
  type SesameCredentials,
} from "./client.js";

export const CANDYHOUSE_STATUS = "candyhouse:status";
export const CANDYHOUSE_HISTORY = "candyhouse:history";
export const CANDYHOUSE_COMMAND = "candyhouse:command";

export interface CandyHouseProviderOptions {
  devices: Readonly<Record<string, SesameCredentials>>;
  fetcher?: typeof fetch;
  now?: () => number;
}

export class CandyHouseProvider implements CapabilityProvider {
  public readonly id = "candyhouse";
  public readonly capabilities = new Set([
    CANDYHOUSE_STATUS,
    CANDYHOUSE_HISTORY,
    CANDYHOUSE_COMMAND,
  ]);
  private readonly clients = new Map<string, SesameClient>();

  public constructor(options: CandyHouseProviderOptions) {
    for (const [alias, credentials] of Object.entries(options.devices)) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(alias)) {
        throw new TypeError(`Invalid Candy House device alias: ${alias}`);
      }
      this.clients.set(
        alias,
        new SesameClient(credentials, options.fetcher, options.now),
      );
    }
  }

  public async execute(request: CapabilityRequest): Promise<unknown> {
    const client = this.clients.get(request.resource);
    if (!client) {
      throw new CapabilityError(
        404,
        "resource_not_found",
        "Unknown device alias.",
      );
    }
    switch (request.capability) {
      case CANDYHOUSE_STATUS:
        return providerRequest(() => client.getStatus());
      case CANDYHOUSE_HISTORY: {
        const input = requireRecord(request.input);
        return providerRequest(() =>
          client.getHistory(
            boundedInteger(input.page, "page", 0, 10_000, 0),
            boundedInteger(input.length, "length", 1, 100, 20),
          ),
        );
      }
      case CANDYHOUSE_COMMAND: {
        const input = requireRecord(request.input);
        const command = requireCommand(input.command);
        const history = requireHistory(input.history);
        return providerRequest(() => client.sendCommand(command, history));
      }
      default:
        throw new CapabilityError(
          404,
          "capability_not_found",
          "Unknown capability.",
        );
    }
  }
}

async function providerRequest(
  operation: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw new CapabilityError(
      502,
      "provider_error",
      "The provider request failed.",
    );
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CapabilityError(400, "invalid_input", "Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const number = typeof value === "string" ? Number(value) : value;
  if (
    !Number.isInteger(number) ||
    Number(number) < minimum ||
    Number(number) > maximum
  ) {
    throw new CapabilityError(
      400,
      "invalid_input",
      `${name} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return Number(number);
}

function requireCommand(value: unknown): SesameCommand {
  if (value === "lock" || value === "unlock" || value === "toggle")
    return value;
  throw new CapabilityError(
    400,
    "invalid_input",
    "command must be lock, unlock, or toggle.",
  );
}

function requireHistory(value: unknown): string {
  if (value === undefined) return "Capability Proxy";
  if (typeof value !== "string" || value.length > 256) {
    throw new CapabilityError(
      400,
      "invalid_input",
      "history must be a string of at most 256 characters.",
    );
  }
  return value;
}
