class CustomError extends Error {
  /** Optional response headers to forward (e.g. Retry-After on 429). */
  public responseHeaders?: Record<string, string>;

  constructor(
    public message: string,
    public status?: number,
    public code?: string
  ) {
    super(message);
    this.name = 'CustomError';
  }
}

export { CustomError };
