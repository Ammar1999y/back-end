import net from 'node:net';
import tls from 'node:tls';
import type { Socket } from 'node:net';
import type Mail from 'nodemailer/lib/mailer';
import type {
  SMTPSentMessageInfo,
  SMTPTransportGetSocketCallback,
  SMTPTransportOptions,
} from 'nodemailer/lib/smtp-transport';

import { createTransport } from 'nodemailer';

/**
 * Nodemailer bounds each SMTP phase and each idle gap, never the whole
 * delivery, so a peer that keeps sending bytes holds `sendMail()` open for as
 * long as it likes. The one handle Nodemailer exposes on the live connection is
 * `getSocket`, its proxy seam: the socket is opened here, so the deadline can
 * destroy it, which fails the send inside Nodemailer instead of abandoning it.
 */
class SmtpDeadlineExceeded extends Error {
  readonly code = 'EDEADLINE';

  constructor(deadlineMs: number) {
    super(`SMTP delivery exceeded ${deadlineMs} ms`);
    this.name = 'SmtpDeadlineExceeded';
  }
}

function openSocket(
  options: SMTPTransportOptions,
  callback: (error: Error | null, socket: Socket) => void
): Socket {
  const host = options.host ?? 'localhost';
  const port = Number(options.port) || (options.secure ? 465 : 587);
  const socket = options.secure
    ? tls.connect({
        host,
        port,
        ...(!net.isIP(host) && { servername: host }),
        ...options.tls,
      })
    : net.connect({ host, port });

  const settle = (error: Error | null) => {
    socket.off('error', onError);
    socket.off('close', onClose);
    callback(error, socket);
  };
  const onError = (error: Error) => settle(error);
  const onClose = () => settle(new Error('SMTP socket closed before connect'));
  socket.once(options.secure ? 'secureConnect' : 'connect', () => {
    socket.setKeepAlive(true);
    settle(null);
  });
  socket.once('error', onError);
  socket.once('close', onClose);
  return socket;
}

export async function sendMailWithDeadline(
  options: SMTPTransportOptions,
  message: Mail.Options,
  deadlineMs: number
): Promise<SMTPSentMessageInfo> {
  const owned: { socket: Socket | null } = { socket: null };
  const transport = createTransport({
    ...options,
    getSocket: (
      resolved: SMTPTransportOptions,
      callback: SMTPTransportGetSocketCallback
    ) => {
      owned.socket = openSocket(resolved, (error, socket) => {
        if (error) callback(error);
        else callback(null, { connection: socket, secured: resolved.secure });
      });
    },
  });

  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    owned.socket?.destroy();
    deadline.reject(new SmtpDeadlineExceeded(deadlineMs));
  }, deadlineMs);

  try {
    return await Promise.race([transport.sendMail(message), deadline.promise]);
  } finally {
    clearTimeout(timer);
    transport.close();
  }
}
