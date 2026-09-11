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

export interface CapabilityProvider {
  readonly id: string;
  readonly capabilities: ReadonlySet<string>;
  execute(request: CapabilityRequest): Promise<unknown>;
}

export interface RelayServerOptions {
  allowedOrigins?: readonly string[];
  allowedHosts?: readonly string[];
}
