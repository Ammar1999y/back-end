class CustomError extends Error {
  /** Optional response headers to forward (e.g. Retry-After on 429). */
  public responseHeaders?: Record<string, string>;

  constructor(
    // `override` rather than dropping the parameter property: `super(message)`
    // alone would leave `message` a NON-enumerable own property (as `Error`
    // defines it), while a parameter property makes it enumerable. Keeping the
    // declaration preserves that, so anything spreading or enumerating a
    // CustomError sees the same shape it always has.
    public override message: string,
    public status?: number,
    public code?: string
  ) {
    super(message);
    this.name = 'CustomError';
  }
}

export { CustomError };
