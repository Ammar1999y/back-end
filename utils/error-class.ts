class CustomError extends Error {
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
