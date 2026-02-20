export function safeDate(
  input: string | Date | number | null | undefined
): Date | null {
  try {
    if (!input) return null;
    const d = new Date(input);
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
    return d;
  } catch {
    return null;
  }
}
