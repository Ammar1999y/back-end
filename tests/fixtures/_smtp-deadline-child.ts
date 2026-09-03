/**
 * Subprocess body for `smtp-deadline.test.ts`.
 *
 * Runs a real SMTP peer on loopback that speaks enough of the protocol to accept
 * a message, and can fall silent at any phase or keep a multi-line reply going
 * for ever — the shape Nodemailer's inactivity timeouts cannot bound. Every
 * Nodemailer phase timeout is set LONGER than the deadline, so a rejection
 * inside the window can only have come from `sendMailWithDeadline`.
 *
 * Two peers: a plaintext one for the protocol phases, and an implicit-TLS one
 * (the mode Gmail's service definition selects) under a self-signed certificate
 * generated in-process, so the `tls.connect` branch — the one production takes
 * — is exercised for a delivery and for a handshake that never completes. A peer
 * that accepts TCP and sends nothing IS the stalled handshake: the client is
 * waiting for a ServerHello that never comes.
 *
 * A child rather than a test file because the base preload replaces the
 * `nodemailer` module for every `bun test` process; this needs the real one.
 * The process ends by itself: a client socket the deadline failed to destroy
 * would keep it alive, so the parent's timeout is the leak detector.
 */
import type { Socket } from 'bun';

import * as x509 from '@peculiar/x509';
import { sendMailWithDeadline } from '@/lib/smtp';

type Mode =
  | 'success'
  | 'greeting'
  | 'ehlo'
  | 'auth'
  | 'data'
  | 'drip'
  | 'tls-success'
  | 'tls-handshake';

const PLAIN_MODES: readonly Mode[] = [
  'success',
  'greeting',
  'ehlo',
  'auth',
  'data',
  'drip',
];

const DEADLINE_MS = 1500;
const PHASE_TIMEOUT_MS = DEADLINE_MS * 4;
const DRIP_INTERVAL_MS = 200;

interface Peer {
  mode: Mode;
  buffer: string;
  inData: boolean;
  drip: ReturnType<typeof setInterval> | null;
}

const state = { mode: 'success' as Mode, open: 0 };

function emit(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ msg, ...extra }));
}

function reply(socket: Socket<Peer>, line: string): void {
  socket.write(`${line}\r\n`);
}

function handleCommand(socket: Socket<Peer>, line: string): void {
  const peer = socket.data;
  const verb = line.split(' ', 1)[0]?.toUpperCase() ?? '';

  if (verb === 'EHLO' || verb === 'HELO') {
    if (peer.mode === 'ehlo') return;
    if (peer.mode === 'drip') {
      peer.drip = setInterval(
        () => reply(socket, '250-still composing a reply'),
        DRIP_INTERVAL_MS
      );
      return;
    }
    socket.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
    return;
  }
  if (verb === 'AUTH') {
    if (peer.mode === 'auth') return;
    reply(socket, '235 2.7.0 Authentication successful');
    return;
  }
  if (verb === 'MAIL' || verb === 'RCPT') {
    reply(socket, '250 OK');
    return;
  }
  if (verb === 'DATA') {
    peer.inData = true;
    reply(socket, '354 End data with <CR><LF>.<CR><LF>');
    return;
  }
  if (verb === 'QUIT') {
    reply(socket, '221 Bye');
    socket.end();
    return;
  }
  reply(socket, '250 OK');
}

const smtpHandlers = {
  open(socket: Socket<Peer>) {
    state.open += 1;
    socket.data = {
      mode: state.mode,
      buffer: '',
      inData: false,
      drip: null,
    };
    if (socket.data.mode !== 'greeting') reply(socket, '220 fake ESMTP');
  },
  data(socket: Socket<Peer>, chunk: Buffer) {
    const peer = socket.data;
    peer.buffer += chunk.toString();

    if (peer.inData) {
      const end = peer.buffer.indexOf('\r\n.\r\n');
      if (end === -1) return;
      peer.buffer = peer.buffer.slice(end + 5);
      peer.inData = false;
      if (peer.mode === 'data') return;
      reply(socket, '250 OK queued');
    }

    let newline = peer.buffer.indexOf('\r\n');
    while (newline !== -1 && !peer.inData) {
      const line = peer.buffer.slice(0, newline);
      peer.buffer = peer.buffer.slice(newline + 2);
      handleCommand(socket, line);
      newline = peer.buffer.indexOf('\r\n');
    }
  },
  close(socket: Socket<Peer>) {
    state.open -= 1;
    if (socket.data.drip) clearInterval(socket.data.drip);
  },
  error() {},
};

const plain = Bun.listen<Peer>({
  hostname: '127.0.0.1',
  port: 0,
  socket: smtpHandlers,
});

/** Accepts TCP and never speaks: to a TLS client, a handshake that never ends. */
const mute = Bun.listen<Peer>({
  hostname: '127.0.0.1',
  port: 0,
  socket: {
    open() {
      state.open += 1;
    },
    data() {},
    close() {
      state.open -= 1;
    },
    error() {},
  },
});

/**
 * A self-signed certificate for the loopback peer, made in-process with
 * WebCrypto and `@peculiar/x509`, so the suite depends on nothing outside
 * `node_modules` — an `openssl` on `PATH` is not something every test machine
 * has. Nothing is written to disk and nothing is committed.
 */
async function selfSignedCertificate(): Promise<{ cert: string; key: string }> {
  x509.cryptoProvider.set(crypto);
  const algorithm = {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256',
    publicExponent: new Uint8Array([1, 0, 1]),
    modulusLength: 2048,
  };
  const keys = await crypto.subtle.generateKey(algorithm, true, [
    'sign',
    'verify',
  ]);
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=127.0.0.1',
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 3_600_000),
    signingAlgorithm: algorithm,
    keys,
    extensions: [
      new x509.SubjectAlternativeNameExtension([
        { type: 'ip', value: '127.0.0.1' },
      ]),
    ],
  });
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keys.privateKey);
  return {
    cert: certificate.toString('pem'),
    key: x509.PemConverter.encode(pkcs8, 'PRIVATE KEY'),
  };
}

const secure = Bun.listen<Peer>({
  hostname: '127.0.0.1',
  port: 0,
  tls: await selfSignedCertificate(),
  socket: smtpHandlers,
});

async function peerSocketsClosed(): Promise<boolean> {
  const until = Date.now() + 1000;
  while (Date.now() < until) {
    if (state.open === 0) return true;
    await Bun.sleep(20);
  }
  return state.open === 0;
}

async function drive(mode: Mode, port: number, tls: boolean): Promise<void> {
  state.mode = mode;
  const started = performance.now();
  let outcome: Record<string, unknown>;
  try {
    const info = await sendMailWithDeadline(
      {
        host: '127.0.0.1',
        port,
        secure: tls,
        // Self-signed loopback certificate; production leaves this unset.
        ...(tls && { tls: { rejectUnauthorized: false } }),
        auth: { user: 'probe', pass: 'probe' },
        connectionTimeout: PHASE_TIMEOUT_MS,
        greetingTimeout: PHASE_TIMEOUT_MS,
        socketTimeout: PHASE_TIMEOUT_MS,
        dnsTimeout: PHASE_TIMEOUT_MS,
      },
      {
        from: 'probe@example.invalid',
        to: 'inbox@example.invalid',
        subject: mode,
        text: mode,
      },
      DEADLINE_MS
    );
    outcome = { settled: 'resolved', messageId: info.messageId };
  } catch (error) {
    outcome = {
      settled: 'rejected',
      name: error instanceof Error ? error.name : 'unknown',
      code: (error as { code?: unknown }).code ?? null,
    };
  }
  const ms = Math.round(performance.now() - started);
  emit('send settled', {
    mode,
    tls,
    ...outcome,
    ms,
    peerClosed: await peerSocketsClosed(),
  });
}

emit('peer listening', { deadlineMs: DEADLINE_MS });

try {
  for (const mode of PLAIN_MODES) await drive(mode, plain.port, false);
  await drive('tls-success', secure.port, true);
  await drive('tls-handshake', mute.port, true);
} finally {
  plain.stop(true);
  secure.stop(true);
  mute.stop(true);
}
emit('done');
