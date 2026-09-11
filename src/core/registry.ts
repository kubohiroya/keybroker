import { CapabilityError } from "./errors.js";
import type {
  CapabilityPrincipal,
  CapabilityProvider,
  CapabilityRequest,
} from "./types.js";

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
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new CapabilityError(404, "provider_not_found", "Unknown provider.");
    }
    if (!provider.capabilities.has(request.capability)) {
      throw new CapabilityError(
        404,
        "capability_not_found",
        "Unknown capability.",
      );
    }
    if (!principal.capabilities.has(request.capability)) {
      throw new CapabilityError(
        403,
        "capability_denied",
        "The paired client is not allowed to use this capability.",
      );
    }
    return provider.execute({ ...request, principal });
  }
}
