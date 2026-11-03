/**
 * Worker JWT issuance and verification. RS256.
 *
 *   - `bootstrap` token (ttl=15m) issued by admin UI, used once to obtain
 *     a rotating long-lived token.
 *   - `refresh` token (ttl=30d) rotated on every refresh call. Each token
 *     carries `jti` + `gen` (generation counter) so a leaked old token is
 *     invalidated once the next refresh happens.
 */
import 'server-only';
import { SignJWT, jwtVerify, importPKCS8, importSPKI } from 'jose';
import { randomUUID } from 'node:crypto';
import { env } from './env';

const ALG = 'RS256';
const ISS = 'hmd-wa-gateway';
const AUD = 'hmd-wa-worker';

async function privateKey() {
  return importPKCS8(env.WORKER_JWT_SIGNING_KEY, ALG);
}
async function publicKey() {
  return importSPKI(env.WORKER_JWT_PUBLIC_KEY, ALG);
}

export async function issueBootstrapToken(params: { workerId: string; createdBy: string }) {
  const jti = randomUUID();
  const token = await new SignJWT({ typ: 'bootstrap', createdBy: params.createdBy })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISS)
    .setAudience(AUD)
    .setSubject(params.workerId)
    .setIssuedAt()
    .setJti(jti)
    .setExpirationTime('15m')
    .sign(await privateKey());
  return { token, jti };
}

export async function issueRefreshToken(params: { workerId: string; generation: number }) {
  const jti = randomUUID();
  const token = await new SignJWT({ typ: 'refresh', gen: params.generation })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISS)
    .setAudience(AUD)
    .setSubject(params.workerId)
    .setIssuedAt()
    .setJti(jti)
    .setExpirationTime('30d')
    .sign(await privateKey());
  return { token, jti };
}

export async function verifyWorkerJwt(token: string): Promise<{
  workerId: string;
  typ: 'bootstrap' | 'refresh';
  gen?: number;
  jti: string;
}> {
  const { payload } = await jwtVerify(token, await publicKey(), {
    issuer: ISS,
    audience: AUD,
  });
  const typ = payload.typ as string | undefined;
  if (typ !== 'bootstrap' && typ !== 'refresh') throw new Error('invalid token type');
  return {
    workerId: String(payload.sub),
    typ,
    gen: typeof payload.gen === 'number' ? payload.gen : undefined,
    jti: String(payload.jti),
  };
}
