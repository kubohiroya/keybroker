import { aesCmac, sesameTimestampMessage } from "./aes-cmac.js";

const API_BASE_URL = "https://app.candyhouse.co/api/sesame2";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const COMMAND_CODES = { lock: 82, unlock: 83, toggle: 88 } as const;

export type SesameCommand = keyof typeof COMMAND_CODES;

export interface SesameCredentials {
  apiKey: string;
  uuid: string;
  secretKey: string;
}

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class SesameClient {
  public constructor(
    private readonly credentials: SesameCredentials,
    private readonly fetcher: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {
    validateCredentials(credentials);
  }

  public async getStatus(): Promise<Record<string, unknown>> {
    return requireRecord(await this.request(this.deviceUrl()));
  }

  public async getHistory(page: number, length: number): Promise<unknown[]> {
    const parameters = new URLSearchParams({
      page: String(page),
      lg: String(length),
    });
    const result = await this.request(
      `${this.deviceUrl()}/history?${parameters}`,
    );
    if (!Array.isArray(result)) {
      throw new Error("Candy House returned an invalid history response.");
    }
    return result;
  }

  public async sendCommand(
    command: SesameCommand,
    history: string,
  ): Promise<unknown> {
    const timestampSeconds = Math.floor(this.now() / 1000);
    const sign = await aesCmac(
      this.credentials.secretKey,
      sesameTimestampMessage(timestampSeconds),
    );
    return this.request(`${this.deviceUrl()}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cmd: COMMAND_CODES[command],
        history: Buffer.from(history, "utf8").toString("base64"),
        sign,
      }),
    });
  }

  private deviceUrl(): string {
    return `${API_BASE_URL}/${encodeURIComponent(this.credentials.uuid)}`;
  }

  private async request(url: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetcher(url, {
      ...init,
      headers: { ...init.headers, "x-api-key": this.credentials.apiKey },
      redirect: "error",
    });
    const body = await response.text();
    const result = parseResponse(body);
    if (!response.ok) {
      throw new Error(
        `Candy House API request failed (${response.status}): ${errorDetail(result)}`,
      );
    }
    return result;
  }
}

export function validateCredentials(credentials: SesameCredentials): void {
  if (credentials.apiKey.trim().length === 0) {
    throw new TypeError("API key must not be empty.");
  }
  if (!UUID_PATTERN.test(credentials.uuid)) {
    throw new TypeError("Sesame UUID must use the canonical UUID format.");
  }
  if (!/^[0-9a-f]{32}$/iu.test(credentials.secretKey)) {
    throw new TypeError(
      "Secret key must be exactly 32 hexadecimal characters.",
    );
  }
}

function parseResponse(body: string): unknown {
  if (body.length === 0) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Candy House returned an invalid status response.");
  }
  return value as Record<string, unknown>;
}

function errorDetail(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const message = record.message ?? record.Message;
    if (typeof message === "string") return message;
  }
  return "unknown error";
}
