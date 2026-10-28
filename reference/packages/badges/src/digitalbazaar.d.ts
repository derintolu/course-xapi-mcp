// SPDX-License-Identifier: Apache-2.0
// Minimal declarations for the untyped Digital Bazaar packages this library uses.

declare module '@digitalbazaar/ed25519-multikey' {
  interface Exported {
    id: string;
    controller: string;
    publicKeyMultibase: string;
    secretKeyMultibase: string;
  }
  interface KeyPair {
    signer(): { sign(o: { data: Uint8Array }): Promise<Uint8Array> };
    verifier(): { verify(o: { data: Uint8Array; signature: Uint8Array }): Promise<boolean> };
    export(o: { publicKey?: boolean; secretKey?: boolean; includeContext?: boolean }): Promise<Exported>;
  }
  export function generate(o?: { id?: string; controller?: string; seed?: Uint8Array }): Promise<KeyPair>;
  export function from(o: object): Promise<KeyPair>;
}

declare module '@digitalbazaar/eddsa-rdfc-2022-cryptosuite' {
  export const cryptosuite: unknown;
}

declare module '@digitalbazaar/data-integrity' {
  export class DataIntegrityProof {
    constructor(o: { signer?: unknown; cryptosuite: unknown });
  }
}

declare module '@digitalbazaar/vc' {
  type Loader = (url: string) => Promise<unknown>;
  export interface VerifyResult {
    verified: boolean;
    error?: unknown;
    results?: { verified: boolean; error?: unknown }[];
  }
  export function issue(o: { credential: object; suite: unknown; documentLoader: Loader }): Promise<object>;
  export function verifyCredential(o: {
    credential: object;
    suite: unknown;
    documentLoader: Loader;
    checkStatus?: (o: unknown) => Promise<{ verified: boolean }>;
  }): Promise<VerifyResult>;
}

declare module '@digitalbazaar/vc-bitstring-status-list' {
  export class BitstringStatusList {
    length: number;
    getStatus(i: number): boolean;
    static decode(o: { encodedList: string }): Promise<BitstringStatusList>;
  }
}
