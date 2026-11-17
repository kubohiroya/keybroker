import { CapabilityError } from "./errors.js";
import type {
  CapabilityPrincipal,
  CapabilityProvider,
  CapabilityRequest,
  MintedCredential,
  RelayRequest,
} from "./types.js";

type Kind = "execute" | "relay" | "mint";

export class CapabilityRegistry {
  private readonly providers = new Map<string, CapabilityProvider>();

  public constructor(providers: readonly CapabilityProvider[]) {
    for (const provider of providers) {
      if (this.providers.has(provider.id)) {
        throw new TypeError(`Duplicate provider: ${provider.id}`);
      }
      this.providers.set(provider.id, provider);
    }
  }

  public async execute(
    providerId: string,
    request: Omit<CapabilityRequest, "principal">,
    principal: CapabilityPrincipal,
  ): Promise<unknown> {
    const provider = this.resolve(providerId, request.capability, principal);
    const execute = method(provider, "execute");
    return execute.call(provider, { ...request, principal });
  }

  public async relay(
    providerId: string,
    request: Omit<RelayRequest, "principal">,
    principal: CapabilityPrincipal,
  ): Promise<Response> {
    const provider = this.resolve(providerId, request.capability, principal);
    const relay = method(provider, "relay");
    return relay.call(provider, { ...request, principal });
  }

  public async mint(
    providerId: string,
    request: Omit<CapabilityRequest, "principal">,
    principal: CapabilityPrincipal,
  ): Promise<MintedCredential> {
    const provider = this.resolve(providerId, request.capability, principal);
    const mint = method(provider, "mint");
    return mint.call(provider, { ...request, principal });
  }

  private resolve(
    providerId: string,
    capability: string,
    principal: CapabilityPrincipal,
  ): CapabilityProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new CapabilityError(404, "provider_not_found", "Unknown provider.");
    }
    if (!provider.capabilities.has(capability)) {
      throw notFound();
    }
    if (!principal.capabilities.has(capability)) {
      throw new CapabilityError(
        403,
        "capability_denied",
        "The paired client is not allowed to use this capability.",
      );
    }
    return provider;
  }
}

function method<K extends Kind>(
  provider: CapabilityProvider,
  kind: K,
): NonNullable<CapabilityProvider[K]> {
  const value = provider[kind];
  if (typeof value !== "function") throw notFound();
  return value as NonNullable<CapabilityProvider[K]>;
}

function notFound(): CapabilityError {
  return new CapabilityError(
    404,
    "capability_not_found",
    "Unknown capability.",
  );
}
