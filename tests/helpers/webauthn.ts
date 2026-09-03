/**
 * A synthetic WebAuthn registration ceremony.
 *
 * The point is the FLAGS byte. Everything else here exists so the response gets
 * far enough into `verifyRegistrationResponse` for the user-verification bit to
 * be the thing under test — a real authenticator is not needed to decide whether
 * the server reads a bit it signed, and a browser cannot be told to clear it.
 *
 * `attestationType: "none"` is what the passkey plugin asks for, so `attStmt` is
 * empty and no attestation signature is verified. The key pair is real because
 * the COSE public key still has to decode.
 */
import crypto from 'node:crypto';

import { isoCBOR } from '@simplewebauthn/server/helpers';

/** WebAuthn L3 §6.1. `AT` says attested credential data follows. */
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

const AAGUID_BYTES = 16;
const CREDENTIAL_ID_BYTES = 16;

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function coseP256PublicKey(): Uint8Array {
  const { publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  // COSE_Key: kty EC2, alg ES256, crv P-256, then the two coordinates.
  return isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))],
    ])
  );
}

export interface RegistrationResponseInput {
  challenge: string;
  origin: string;
  rpId: string;
  /** The signed UV bit. `false` is an authenticator that proved a device only. */
  userVerified: boolean;
}

export interface SyntheticRegistration {
  credentialId: string;
  response: Record<string, unknown>;
}

export function buildRegistrationResponse(
  input: RegistrationResponseInput
): SyntheticRegistration {
  const credentialId = crypto.randomBytes(CREDENTIAL_ID_BYTES);
  const publicKey = coseP256PublicKey();

  const flags = Buffer.from([
    FLAG_UP | FLAG_AT | (input.userVerified ? FLAG_UV : 0),
  ]);
  const signCount = Buffer.alloc(4);
  const credentialIdLength = Buffer.alloc(2);
  credentialIdLength.writeUInt16BE(credentialId.length);

  const authData = Buffer.concat([
    crypto.createHash('sha256').update(input.rpId).digest(),
    flags,
    signCount,
    Buffer.alloc(AAGUID_BYTES),
    credentialIdLength,
    credentialId,
    Buffer.from(publicKey),
  ]);

  const attestationObject = isoCBOR.encode(
    new Map<string, unknown>([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', new Uint8Array(authData)],
    ]) as never
  );

  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: 'webauthn.create',
      challenge: input.challenge,
      origin: input.origin,
      crossOrigin: false,
    }),
    'utf8'
  );

  const id = base64url(credentialId);
  return {
    credentialId: id,
    response: {
      id,
      rawId: id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: base64url(clientDataJSON),
        attestationObject: base64url(attestationObject),
        transports: ['internal'],
      },
    },
  };
}
