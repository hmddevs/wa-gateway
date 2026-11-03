/**
 * WebAuthn credential repository. Each admin email may hold multiple
 * passkeys. Counter is updated on every successful assertion to detect
 * cloned authenticators.
 */
import 'server-only';
import type { ObjectId } from 'mongodb';
import { col } from '../mongo';

export interface WebAuthnCredentialDoc {
  _id?: ObjectId;
  email: string;
  credentialId: string; // base64url
  publicKey: string; // base64url of COSE key
  counter: number;
  transports?: string[];
  deviceName?: string;
  createdAt: Date;
  lastUsedAt?: Date | null;
}

export async function listByEmail(email: string): Promise<WebAuthnCredentialDoc[]> {
  const c = await col<WebAuthnCredentialDoc>('webauthn_credentials');
  return c.find({ email: email.toLowerCase() }).toArray();
}

export async function findByCredentialId(id: string): Promise<WebAuthnCredentialDoc | null> {
  const c = await col<WebAuthnCredentialDoc>('webauthn_credentials');
  return c.findOne({ credentialId: id });
}

export async function insertCredential(doc: WebAuthnCredentialDoc): Promise<void> {
  const c = await col<WebAuthnCredentialDoc>('webauthn_credentials');
  await c.insertOne(doc);
}

export async function updateCounter(id: string, counter: number): Promise<void> {
  const c = await col<WebAuthnCredentialDoc>('webauthn_credentials');
  await c.updateOne({ credentialId: id }, { $set: { counter, lastUsedAt: new Date() } });
}

export async function deleteCredential(email: string, id: string): Promise<void> {
  const c = await col<WebAuthnCredentialDoc>('webauthn_credentials');
  await c.deleteOne({ email: email.toLowerCase(), credentialId: id });
}
