/**
 * The in-process outbox `OTP_DELIVERY=outbox` delivers to instead of a provider.
 *
 * In memory and never logged: the plaintext code is here so a test can read it
 * back, and nowhere else. `utils/validation/otp.ts` refuses the mode in
 * production, so nothing in this file can run there.
 */
import type { OtpChannel, OtpPurpose } from './validation/otp';

export interface OutboxDelivery {
  channel: OtpChannel;
  destination: string;
  purpose: OtpPurpose;
  code: string;
  /** Email only. */
  subject: string | null;
  text: string;
  at: Date;
}

const deliveries: OutboxDelivery[] = [];

export function recordOutboxDelivery(
  delivery: Omit<OutboxDelivery, 'at'>
): void {
  deliveries.push({ ...delivery, at: new Date() });
}

export function readOutbox(
  filter: Partial<
    Pick<OutboxDelivery, 'channel' | 'destination' | 'purpose'>
  > = {}
): OutboxDelivery[] {
  return deliveries.filter(
    (delivery) =>
      (filter.channel === undefined || delivery.channel === filter.channel) &&
      (filter.destination === undefined ||
        delivery.destination === filter.destination) &&
      (filter.purpose === undefined || delivery.purpose === filter.purpose)
  );
}

export function clearOutbox(): void {
  deliveries.length = 0;
}
