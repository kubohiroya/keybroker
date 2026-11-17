export interface CapabilityPrincipal {
  id: string;
  capabilities: ReadonlySet<string>;
}

export interface CapabilityRequest {
  capability: string;
  resource: string;
  input?: unknown;
  principal: CapabilityPrincipal;
}

/**
 * A relay passes a stream to an upstream route the provider builds itself,
 * such as Git Smart HTTP or a WebSocket upgrade. The client never chooses the
 * upstream URL.
 */
export interface RelayRequest {
  capability: string;
  resource: string;
  request: Request;
  principal: CapabilityPrincipal;
}

/** A short-lived credential the client uses to call the upstream directly. */
export interface MintedCredential {
  value: string;
  expiresAt: number;
}

/**
 * A provider offers each capability as one of three kinds: a call (`execute`,
 * JSON in and out), a relay (`relay`, a stream to a fixed upstream route) or a
 * mint (`mint`, a short-lived credential for the upstream).
 */
export interface CapabilityProvider {
  readonly id: string;
  readonly capabilities: ReadonlySet<string>;
  execute?(request: CapabilityRequest): Promise<unknown>;
  relay?(request: RelayRequest): Promise<Response>;
  mint?(request: CapabilityRequest): Promise<MintedCredential>;
}

export interface RelayServerOptions {
  allowedOrigins?: readonly string[];
  allowedHosts?: readonly string[];
}
