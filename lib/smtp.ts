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

/** A transport Nodemailer has already resolved a host for. */
type ResolvedTransport = SMTPTransportOptions & { host: string };

/**
 * The transport is checked at the one point where it is fully resolved:
 * `service` is merged into `host`/`port`/`secure` by Nodemailer's constructor,
 * so neither `smtpTransportOptions()` nor this module's own argument carries the
 * answer — only the options handed to `getSocket` do.
 *
 * Refused rather than defaulted, because each default is a silent downgrade of
 * what the caller asked for: an unresolved host becomes `localhost`, and a
 * transport without implicit TLS negotiates STARTTLS only if the peer offers it,
 * so a stripped EHLO would send the message — an OTP code — in cleartext.
 *
 * `ignoreTLS` is the one way past the second check, and it is Nodemailer's own
 * flag rather than a local invention: renouncing transport security has to be
 * written down in the transport options, where it is greppable, instead of
 * following from the absence of a field. The only sender is Gmail
 * (`secure: true`); the loopback peers in `tests/fixtures` are what sets it.
 */
function resolveTransport(
  options: SMTPTransportOptions
): ResolvedTransport | Error {
  if (!options.host)
    return new Error(
      'SMTP transport resolved no host; configure `service` or `host`'
    );
  if (
    options.secure !== true &&
    options.requireTLS !== true &&
    options.ignoreTLS !== true
  )
    return new Error(
      `SMTP transport for ${options.host} has neither implicit TLS (\`secure\`) ` +
        'nor mandatory STARTTLS (`requireTLS`); set `ignoreTLS` to send in cleartext'
    );
  return { ...options, host: options.host };
}

function openSocket(
  options: ResolvedTransport,
  callback: (error: Error | null, socket: Socket) => void
): Socket {
  const { host } = options;
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
      const peer = resolveTransport(resolved);
      if (peer instanceof Error) {
        callback(peer);
        return;
      }
      owned.socket = openSocket(peer, (error, socket) => {
        if (error) callback(error);
        else callback(null, { connection: socket, secured: peer.secure });
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
