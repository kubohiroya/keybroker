export class CapabilityError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CapabilityError";
  }
}

export function toPublicError(error: unknown): {
  status: number;
  body: { error: { code: string; message: string } };
} {
  if (error instanceof CapabilityError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message } },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: "internal_error",
        message: "The relay could not complete the request.",
      },
    },
  };
}
