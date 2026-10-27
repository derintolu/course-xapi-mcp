// SPDX-License-Identifier: Apache-2.0
// The server's own learner accounts (custody option 3): scrypt password hashes and sign-in throttling.
import { randomBytes, randomUUID, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { AuthStore } from './stores.ts';

const USERNAME = /^[a-z0-9._-]{3,64}$/;
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 1024;
const SCRYPT: ScryptOptions = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;
const SALT_BYTES = 16;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
/** Hashed for unknown usernames so a sign-in takes as long whether or not the account exists. */
const DUMMY_SALT = Buffer.alloc(SALT_BYTES);

export type SignInResult = { subject: string } | { error: string; status: 400 | 429 };

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFC'), salt, KEY_LENGTH, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function signUp(store: AuthStore, username: string, password: string): Promise<SignInResult> {
  if (!USERNAME.test(username)) {
    return { error: 'A username is 3 to 64 characters: lowercase letters, digits, dot, dash or underscore.', status: 400 };
  }
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    return { error: 'A password is at least 12 characters.', status: 400 };
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt);
  const id = randomUUID();
  const created = await store.createAccount({ id, username, salt: salt.toString('base64'), hash: hash.toString('base64') });
  if (!created) return { error: 'That username is taken.', status: 400 };
  return { subject: id };
}

export async function signIn(store: AuthStore, username: string, password: string, now: number): Promise<SignInResult> {
  if (await store.signInFailuresSince(username, now - FAILURE_WINDOW_MS) >= MAX_FAILURES) {
    return { error: 'Too many failed sign-ins for this username. Wait 15 minutes and try again.', status: 429 };
  }
  const account = USERNAME.test(username) ? await store.getAccount(username) : undefined;
  const salt = account ? Buffer.from(account.salt, 'base64') : DUMMY_SALT;
  const computed = await derive(password.slice(0, MAX_PASSWORD), salt);
  if (account && timingSafeEqual(computed, Buffer.from(account.hash, 'base64'))) return { subject: account.id };
  await store.addSignInFailure(username, now);
  return { error: 'The username or password is wrong.', status: 400 };
}
