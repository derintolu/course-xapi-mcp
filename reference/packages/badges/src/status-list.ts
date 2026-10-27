// SPDX-License-Identifier: Apache-2.0
// Bitstring Status List (revocation): random indexes, GZIP + base64url multibase encoding.
import { randomInt } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { DEFAULTS } from '@course-xapi-mcp/core';
import { CONTEXTS } from './document-loader.ts';

export interface StatusEntry {
  id: string;
  type: 'BitstringStatusListEntry';
  statusPurpose: 'revocation';
  statusListIndex: string;
  statusListCredential: string;
}

export interface StatusList {
  /** A fresh random index, never handed out before by this list. */
  allocate(): number;
  revoke(i: number): void;
  isRevoked(i: number): boolean;
  /** The `encodedList` value: `u` + base64url(gzip(bits)), bit 0 the leftmost bit of byte 0. */
  encode(): string;
  entry(listUrl: string, i: number): StatusEntry;
}

export function createStatusList(length: number = DEFAULTS.statusListLength): StatusList {
  if (!Number.isInteger(length) || length <= 0 || length % 8 !== 0) throw new RangeError('Status list length must be a positive multiple of 8.');
  const bits = new Uint8Array(length / 8);
  const allocated = new Set<number>();
  const check = (i: number) => {
    if (!Number.isInteger(i) || i < 0 || i >= length) throw new RangeError(`Status list index ${i} is out of range.`);
  };
  return {
    allocate() {
      if (allocated.size >= length) throw new Error('Status list is full.');
      let i: number;
      do i = randomInt(length);
      while (allocated.has(i));
      allocated.add(i);
      return i;
    },
    revoke(i) {
      check(i);
      bits[i >> 3] |= 0x80 >> (i & 7);
    },
    isRevoked(i) {
      check(i);
      return (bits[i >> 3] & (0x80 >> (i & 7))) !== 0;
    },
    encode() {
      return 'u' + Buffer.from(gzipSync(bits)).toString('base64url');
    },
    entry(listUrl, i) {
      check(i);
      return {
        id: `${listUrl}#${i}`,
        type: 'BitstringStatusListEntry',
        statusPurpose: 'revocation',
        statusListIndex: String(i),
        statusListCredential: listUrl,
      };
    },
  };
}

/** The unsigned BitstringStatusListCredential published at `listUrl`. `issuer` is the issuer DID. */
export function statusListCredential(o: { listUrl: string; issuer: string; list: StatusList; validFrom: string }): object {
  return {
    '@context': [CONTEXTS.credentialsV2],
    id: o.listUrl,
    type: ['VerifiableCredential', 'BitstringStatusListCredential'],
    issuer: o.issuer,
    validFrom: o.validFrom,
    credentialSubject: {
      id: o.listUrl + '#list',
      type: 'BitstringStatusList',
      statusPurpose: 'revocation',
      encodedList: o.list.encode(),
    },
  };
}
