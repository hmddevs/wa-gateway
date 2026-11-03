/**
 * WebAuthn helpers. Uses @simplewebauthn/server. Challenges are cached in
 * Redis keyed by email for 5 minutes.
 */
import 'server-only';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { env } from './env';
import { getRedis } from './redis';
import {
  listByEmail,
  insertCredential,
  findByCredentialId,
  updateCounter,
} from './repositories/webauthn';

const CHALLENGE_TTL = 300;

function challengeKey(email: string, kind: 'reg' | 'auth') {
  return `webauthn:${kind}:${email.toLowerCase()}`;
}

export async function beginRegistration(email: string) {
  const existing = await listByEmail(email);
  const opts = await generateRegistrationOptions({
    rpID: env.WEBAUTHN_RP_ID,
    rpName: env.WEBAUTHN_RP_NAME,
    userName: email,
    userDisplayName: email,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
    },
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports as never,
    })),
  });
  await getRedis().set(challengeKey(email, 'reg'), opts.challenge, 'EX', CHALLENGE_TTL);
  return opts;
}

export async function finishRegistration(email: string, response: unknown, deviceName?: string) {
  const expectedChallenge = await getRedis().get(challengeKey(email, 'reg'));
  if (!expectedChallenge) throw new Error('WEBAUTHN_CHALLENGE_EXPIRED');

  const verification = await verifyRegistrationResponse({
    response: response as any,
    expectedChallenge,
    expectedOrigin: env.NEXTAUTH_URL.replace(/\/$/, ''),
    expectedRPID: env.WEBAUTHN_RP_ID,
    requireUserVerification: true,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('WEBAUTHN_VERIFY_FAILED');
  }
  const info = verification.registrationInfo;
  const anyInfo = info as any;
  const credentialId: string =
    typeof anyInfo.credentialID === 'string'
      ? anyInfo.credentialID
      : Buffer.from(anyInfo.credentialID as Uint8Array).toString('base64url');
  const publicKeyB64: string = Buffer.from(anyInfo.credentialPublicKey as Uint8Array).toString(
    'base64url',
  );
  const counter: number = Number(anyInfo.counter ?? 0);
  const transports = (anyInfo.transports as string[] | undefined) ?? [];
  await insertCredential({
    email: email.toLowerCase(),
    credentialId,
    publicKey: publicKeyB64,
    counter,
    transports,
    deviceName: deviceName ?? 'passkey',
    createdAt: new Date(),
    lastUsedAt: null,
  });
  await getRedis().del(challengeKey(email, 'reg'));
  return { ok: true as const, credentialId };
}

export async function beginAuthentication(email: string) {
  const creds = await listByEmail(email);
  const opts = await generateAuthenticationOptions({
    rpID: env.WEBAUTHN_RP_ID,
    userVerification: 'required',
    allowCredentials: creds.map((c) => ({
      id: c.credentialId,
      transports: c.transports as never,
    })),
  });
  await getRedis().set(challengeKey(email, 'auth'), opts.challenge, 'EX', CHALLENGE_TTL);
  return opts;
}

export async function finishAuthentication(email: string, response: unknown) {
  const expectedChallenge = await getRedis().get(challengeKey(email, 'auth'));
  if (!expectedChallenge) throw new Error('WEBAUTHN_CHALLENGE_EXPIRED');

  const credId = (response as any)?.id as string | undefined;
  if (!credId) throw new Error('WEBAUTHN_NO_CREDENTIAL_ID');
  const stored = await findByCredentialId(credId);
  if (!stored || stored.email !== email.toLowerCase()) throw new Error('WEBAUTHN_UNKNOWN_CRED');

  const verification = await verifyAuthenticationResponse({
    response: response as any,
    expectedChallenge,
    expectedOrigin: env.NEXTAUTH_URL.replace(/\/$/, ''),
    expectedRPID: env.WEBAUTHN_RP_ID,
    authenticator: {
      credentialID: stored.credentialId,
      credentialPublicKey: Buffer.from(stored.publicKey, 'base64url'),
      counter: stored.counter,
      transports: stored.transports as never,
    } as any,
    requireUserVerification: true,
  } as any);

  if (!verification.verified) throw new Error('WEBAUTHN_VERIFY_FAILED');
  await updateCounter(stored.credentialId, verification.authenticationInfo.newCounter);
  await getRedis().del(challengeKey(email, 'auth'));
  return { ok: true as const };
}
