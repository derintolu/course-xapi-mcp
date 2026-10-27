# Open Badges for course-xapi-mcp, the WordPress LRS plugin and Learn WordPress Reimagined

Date: 2026-10-27. Research only; no repo was changed and nothing was published. Facts carry a source URL; my own reasoning is marked **(inference)**. Where a source is a vendor blog or a secondary page, I say so.

Main sources and the short names used below:

- **[OB3]** Open Badges 3.0, Document Version 1.4.5, Final Release, issued 29 June 2026: https://www.imsglobal.org/spec/ob/v3p0/main/
- **[OB3-IMPL]** Open Badges 3.0 Implementation Guide, Document Version 2.1, issued 15 June 2026: https://www.imsglobal.org/spec/ob/v3p0/impl/
- **[OB3-CERT]** Open Badges Conformance and Certification Guide v3.0, Document Version 1.5, issued 15 June 2026: https://www.imsglobal.org/spec/ob/v3p0/cert/
- **[CLR2]** Comprehensive Learner Record 2.0, Document Version 1.1, Final, issued 14 October 2025: https://www.imsglobal.org/spec/clr/v2p0/
- **[LIC]** 1EdTech Specification Document License: https://www.1edtech.org/standards/specification-license
- **[BSL]** W3C Bitstring Status List v1.0 (Recommendation, 15 May 2025): https://www.w3.org/TR/vc-bitstring-status-list/
- **[VC2-NEWS]** W3C, "The Verifiable Credentials 2.0 family of specifications is now a W3C Recommendation" (15 May 2025): https://www.w3.org/news/2025/the-verifiable-credentials-2-0-family-of-specifications-is-now-a-w3c-recommendation
- **[CMI5-FIT]** our own cmi5 fit report: /private/tmp/claude-501/-Users-cedarstone-Projects-learn-wp-reimagined/5376001d-2862-4ef6-85e3-26e5bd4cbe50/scratchpad/cmi5-fit.md
- Project files: /Users/cedarstone/Projects/learning-mcp/docs/spec.md, /Users/cedarstone/Projects/learning-mcp/RULES.md

---

## 0. Recommendation (read this first)

1. **The standard (course-xapi-mcp) defines *when* a badge is earned and *what it says*. It does not sign anything.** It should define: a badge declaration per lesson/path/course in the course manifest (Achievement fields), the trigger (cmi5 `satisfied` for a block or course, or an AU's moveOn being met), the evidence shape (opaque references to xAPI statements, no PII), the recipient-binding rules, and an "earned" xAPI statement written after issuance. Everything else should be "conform to OB 3.0", referenced rather than copied, because the 1EdTech licence grants no right to make derivatives of its documents ([LIC] §4).
2. **The issuer is whoever holds the official record: the LRS plugin, not the course server.** A badge is only as trustworthy as the satisfaction decision behind it. If the course server signs from a learner-held record, the learner could edit the record and then get a validly signed badge. The issuer has to compute satisfaction from statements in a store the learner cannot write to directly, and that store is the LRS **(inference, from the ownership model in [CMI5-FIT] C1/C4 and RULES.md §5)**. In standalone mode with no LRS, the course server may issue, but the standard should label those badges as "self-hosted issuer" (in the inference sense: trust follows the issuer's domain).
3. **Proof format: Data Integrity `eddsa-rdfc-2022` (Ed25519) first, with a `did:web` issuer.** This is the only option that the 1EdTech conformance suite accepts ([OB3-CERT] §3.1.1) *and* that the DCC/Learner Credential Wallet verifier stack accepts. That stack verifies Data Integrity proofs and lists no VC-JWT support (https://github.com/digitalcredentials/verifier-core). VC-JWT with RS256 is easier to write in PHP, but on its own it would not verify in LCW or VerifierPlus. Add it as a second envelope later if a consumer needs it ([OB3] §8.1 allows multiple proofs). Skip `eddsa-jcs-2022`: it is the easiest to write, but neither the 1EdTech conformance suite nor DCC verifier-core lists it.
4. **Revocation: W3C Bitstring Status List** (`BitstringStatusListEntry`, `statusPurpose: "revocation"`). OB 3.0 deprecated the old 1EdTech Revocation List in favour of it in version 1.3, 9 October 2025 ([OB3] Revision History), and the Displayer conformance tests now check it ([OB3-CERT] §4.1).
5. **Recipient:** use a learner DID (`credentialSubject.id`) when a wallet has proven control of it. Otherwise use a salted, hashed `IdentityObject` of a value the learner chooses to share (usually an email). **Never** put the xAPI anonymous account name in the badge, even hashed, because that would link the badge to the whole learning record (§6).
6. **OB 2.0:** don't build it for the prototype. Plan an optional OB 2.0 "hosted" export later, served at separate URLs and linked through `related`, as 1EdTech advises ([OB3-IMPL] §6.1).
7. **Prototype needs** (§7.3): one Ed25519 key, a `did:web` document, an issuer Profile, three Achievement definitions, an issue-on-satisfied hook in the LRS plugin, one status list, a "download / add to wallet" page, and a check against the 1EdTech validator at https://vc.1ed.tech.

---

## 1. Open Badges 3.0: status, structure, licence

### 1.1 Version and status

- Current: **Open Badges 3.0, Final Release, Document Version 1.4.5, issued 29 June 2026** ([OB3] header). It was first released as Final on 27 May 2024. Errata releases since then:
  - 1.1 (Jul 2024)
  - 1.2 (Dec 2024): "clarified proof mechanism and algorithm selection"
  - 1.3 (9 Oct 2025): "Deprecated [VCRL-10] in favour of [vc-bitstring-status-list]"
  - 1.4 (14 Oct 2025): credentialStatus `id` made optional
  - 1.4.1 (Nov 2025): `jti` added to the context
  - 1.4.2 (17 Apr 2026): examples switched to BitstringStatusListEntry
  - 1.4.3 and 1.4.4 (Apr and Jun 2026): OpenAPI fixes
  - 1.4.5 (29 Jun 2026): `endorsementJwt` added to the context

  Source: [OB3] "G. Revision History". The errata list is at https://www.imsglobal.org/spec/ob/v3p0/errata/.
- The current JSON-LD context is `https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json`, used together with `https://www.w3.org/ns/credentials/v2` ([OB3] §5, Example 1).

### 1.2 Relation to W3C VC Data Model 2.0

- The abstract says OB 3.0 "aligns with the conventions of the Verifiable Credentials Data Model v2.0", and an OB 3.0 assertion *is* a Verifiable Credential whose issuer is the VC `issuer` ([OB3] Abstract, §1.5). JSON Schemas for VC DM 2.0 are the default, and VC DM 1.1-compatible schemas are still provided for older credentials, which use `issuanceDate`/`expirationDate` instead of `validFrom`/`validUntil` ([OB3] §1.2.3, §9.1 note).
- VC DM 2.0, Data Integrity 1.0, the EdDSA and ECDSA cryptosuites, VC-JOSE-COSE and Bitstring Status List all became W3C Recommendations on 15 May 2025 ([VC2-NEWS]; [BSL]).
- W3C published a First Public Working Draft of **VC Data Model v2.1** on 9 April 2026 (https://www.w3.org/news/2026/first-public-working-draft-verifiable-credentials-data-model-v2-1). OB 3.0 still targets 2.0. Watch it, but don't build on it.

### 1.3 Data model (multiplicities from [OB3] §B.1)

**OpenBadgeCredential / AchievementCredential** (the signed thing):

- Required:
  - `@context`
  - `id` (URI)
  - `type` (must include `VerifiableCredential` and `OpenBadgeCredential` or `AchievementCredential`)
  - `issuer` (ProfileRef)
  - `validFrom` (DateTimeZ)
  - `credentialSubject` (AchievementSubject)
- Optional: `name`, `description`, `image`, `awardedDate`, `validUntil`, `proof` [0..*], `credentialSchema`, `credentialStatus` [0..1], `refreshService`, `termsOfUse`, `evidence` [0..*], `endorsement`/`endorsementJwt`.
- Note: an embedded proof MUST be in `proof`, and "at least one proof mechanism … MUST be expressed" for the credential to be verifiable ([OB3] §B.1.2).

**AchievementSubject** (the recipient):

- Required: `type`, `achievement` [1].
- `id` [0..1] and `identifier` (IdentityObject) [0..*] are each optional, but verification fails if **neither** is present ([OB3] §9.1).
- Other optional fields: `result` [0..*], `narrative`, `activityStartDate`, `activityEndDate`, `creditsEarned`, `term`, `role`, `licenseNumber`, `source`, `image`.

**Achievement** (the badge definition, like the old BadgeClass):

- Required: `id` (URI), `type`, `name`, `description`, `criteria` (`id` and/or `narrative`).
- Optional:
  - `achievementType`: the enum includes `Badge`, `Course`, `LearningProgram`, `Competency`, `CertificateOfCompletion`, `Assessment`, and others ([OB3] §B.1.28)
  - `alignment` [0..*]
  - `resultDescription` [0..*]
  - `creator` (Profile)
  - `image`, `tag`, `version`, `inLanguage`, `humanCode`, `fieldOfStudy`, `specialization`, `creditsAvailable`
  - `related` [0..*], `otherIdentifier`
  - `endorsement`

**Profile** (the issuer):

- Required: `id` (URI) and `type`. Everything else is optional: `name`, `url`, `email`, `image`, `description`, `address`, `parentOrg`, `official`, `otherIdentifier`, and the person-name fields.
- The issuer `id` is what a verifier ties to the signing key ([OB3] §B.1.14; [OB3-IMPL] §3.1.12).

**Evidence** [0..*]: `type` (required), plus optional `id` (URI), `narrative`, `name`, `description`, `genre`, `audience` ([OB3] §B.1.9).

**Alignment**: required `type`, `targetName`, `targetUrl`; optional `targetCode`, `targetDescription`, `targetFramework`, `targetType` ([OB3] §B.1.5). Examples D.4 and D.5 show CASE and Credential Engine alignments.

**Result and ResultDescription**:

- A `Result` has optional `value`, `status`, `achievedLevel`, `resultDescription` (a URI into the Achievement's `resultDescription`) and `alignment` ([OB3] §B.1.16).
- A `ResultDescription` requires `id`, `type`, `name`, `resultType`. Result types include `Percent`, `ScaledScore`, `RawScore`, `Status`, `RubricScore`, and others ([OB3] §B.1.17, §B.1.31).
- `ResultStatusType` values: `Completed` (the default when no status is given), `Enrolled`, `Failed`, `InProgress`, `OnHold`, `Provisional`, and others ([OB3] §B.1.32).
- **Fit:** a cmi5 scaled score can map to a ScaledScore result, and moveOn met can map to status Completed **(inference)**.

**IdentityObject** (a hashed or plain recipient identifier):

- Fields: `type`, `hashed` (bool), `identityHash`, `identityType`, and optional `salt`.
- `identityHash` is `"sha256$" + hex(sha256(identifier + salt))`. `md5` is also allowed.
- `identityType` values from IdentifierTypeEnum: `emailAddress`, `accountId`, `userName`, `systemId`, `sourcedId`, `ltiUserId`, `identifier`, and others; the list is extensible with `ext:` terms.

Source: [OB3] §B.1.12, §B.1.30, §B.8 "IdentityHash".

**CredentialStatus / RefreshService / CredentialSchema**:

- Status: §1.4 below.
- `refreshService` type `1EdTechCredentialRefresh` lets a verifier fetch an updated credential.
- `credentialSchema` type `1EdTechJsonSchemaValidator2019` points at the 1EdTech JSON Schema.

Source: [OB3] §9.1, §B.1.21 to §B.1.25.

**Credential identity:** two credentials are "the same" when `issuer.id` and credential `id` match, and the one with the newer `validFrom` replaces the other ([OB3] §10). **(inference)** Re-issuing a badge with a new key or a new cryptosuite is therefore "same id, newer validFrom".

### 1.4 How a badge is issued, delivered and verified

**Issued.** Build the credential and sign it. There are two proof formats ([OB3] §8.1):

- **VC-JWT** (an external proof). This is a compact JWS whose payload is the credential plus the JWT claims `iss`=issuer.id, `jti`=credential id, `nbf`=validFrom, `sub`=credentialSubject.id, and `exp`=validUntil if set ([OB3] §8.2.4.1).
  - The JOSE header allows only `alg`, `kid`, `jwk` and `typ`; "Additional JOSE Headers are NOT allowed" ([OB3] §8.2.3).
  - `alg` "MUST be RS256 as a minimum". Other algorithms are permitted, "but their use limits interoperability" ([OB3] §8.2.3).
  - Either a `kid` that dereferences to a JWK, or an inline `jwk`, is required, and the JWK must never contain `d`.
- **Linked Data proof** (an embedded `proof`). "In order to pass conformance tests for this format issuers MUST use an option supported by the 1EdTech conformance test suite" ([OB3] §8.3). Per [OB3-CERT] §3.1.1 (v1.2, July 2025), those options are:
  - Data Integrity EdDSA Cryptosuites v1.0 with `eddsa-rdfc-2022`
  - ECDSA with `ecdsa-sd-2023`
- The proof uses `proofPurpose: "assertionMethod"` ([OB3] §8.3.1, §B.1.24).
- Several proofs are allowed, and a verifier may accept any one of them. If both are used, the LD proof is added first and then wrapped in the JWT ([OB3] §8.1, §8.2.2).
- Key management is "outside the scope" of OB 3.0 ([OB3] §8.4). Public keys may be dereferenced by an HTTP URL or a DID URL, "but only requires HTTP URL support" ([OB3] §8.5).

**Delivered** ([OB3] §5, §6, §7):

- As a file: one credential, as JSON, or as the JWS string for VC-JWT.
- As a web resource.
- **Baked** into a PNG (an `iTXt` chunk with keyword `openbadgecredential`, uncompressed) or an SVG.
- Through the **Open Badges API**: REST endpoints `/ims/ob/v3p0/credentials` and `/profile`, a discovery document, OAuth 2.0 Authorization Code with PKCE, and dynamic client registration ([OB3] §6 and §7; [OB3-IMPL] §2.2).
- To wallets: [OB3-IMPL] §3.4.3 lists CHAPI, DIDComm and OID4VC as transport protocols "under development … pre-standardization".
- Since then, **OpenID for Verifiable Credential Issuance 1.0** went to its Final Specification vote in September 2025 (https://openid.net/notice-of-vote-openid-for-verifiable-credential-issuance-1-0-final-specification/; spec at https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html).
- LCW 2.2.10 (June 2026) supports the **VC-API Interaction URL**, "allowing a single QR code or link to work with multiple digital wallets" (https://github.com/digitalcredentials/learner-credential-wallet README, "News - June 2026").

**Verified** ([OB3] §9.1):

1. Check the JSON Schema (if `credentialSchema` is given) and that the subject has an `id` or `identifier`.
2. Verify one proof, using the JWT steps in §8.2.6 or the Data Integrity verification algorithm.
3. Optionally refresh (only once).
4. Check status: revoked if a `BitstringStatusListEntry` says so.
5. Check validFrom and validUntil.
6. Optionally verify the recipient against a known value. For a hashed identifier, recompute `sha256(known + salt)` ([OB3] §9.3).
7. Verify any endorsements.

1EdTech's certification additionally requires that the badge passes **JSON-LD validation in "safe mode"**, meaning an error whenever a term is undefined by the contexts ([OB3-CERT] §3, v1.3, Dec 2025). This bites anyone who adds custom properties (§4.3).

### 1.5 Licence, IPR and certification

- **Implementing is royalty-free.** The 1EdTech licence grants "a worldwide, perpetual, royalty-free, nontransferable, nonexclusive, nonsublicenseable license … for the purpose of developing, making, … and selling or licensing, and to otherwise distribute, products that implement this Specification(s)" ([LIC] §3).
- Conditions:
  - You must "publicly and visibly acknowledge and attribute to 1EdTech the Specification(s)" ([LIC] §2c, §3).
  - "**No right to create modifications or derivatives of 1EdTech documents is granted**" ([LIC] §4). **(inference)** course-xapi-mcp should *reference* OB 3.0 and define only its own profile and extension terms. It should not copy spec text into the Apache-2.0 repo.
- Patent picture: the participating organisations (Credly, Concentric Sky, D2L, Anthology, WGU and others) elected "RF RAND (Required & Optional Elements)" and declared "No" necessary claims. 1EdTech warns there is no warranty of non-infringement ([OB3] IPR notice).
- **Certification is not required to implement or claim conformance to the spec in your own words. It is required to use the "1EdTech certified" mark.** Requirements ([OB3-CERT] §2.2):
  - be "an 1EdTech Digital Credentials and Badges Alliance Member, an 1EdTech Affiliate Member, or 1EdTech Contributing Member"
  - pass the hosted test suite
  - have tests run by a member representative
  - after approval, you are listed in the Certified Products Directory and may show the logo
- The Issuer test: issue a valid badge to `conformance@imsglobal.org`, submit it, and "Demonstrate through video" how the recipient retrieves it ([OB3-CERT] §3.1).
- **Cost:** 1EdTech publishes no price. Alliance membership includes certification "at no extra cost", and members can certify any number of products per Alliance category (https://1edtech.org/1edtech-digital-credentials-and-badging-alliance/learn%20more). Membership pages say to contact 1EdTech for pricing (https://www.1edtech.org/about/membership/supplier). **Unknown figure. Ask support@1edtech.org.**
- **Free alternative to certification:** the 1EdTech public validator (Apache-2.0, primarily for OB 3.0, live at https://vc.1ed.tech; https://github.com/1EdTech/digital-credentials-public-validator).

### 1.6 Comprehensive Learner Record 2.0

- **CLR 2.0, Final, Document Version 1.1, issued 14 October 2025.** It reached Final on 26 February 2025, and 1.1 deprecated the 1EdTech revocation list in favour of Bitstring Status List ([CLR2] header, Revision History).
- How it bundles badges: a `ClrCredential` is itself a VC. Required: `id`, `type`, `name`, `issuer`, `validFrom`, `credentialSubject` (ClrSubject); optional `partial` and the same proof and status machinery ([CLR2] §B.1.1).
- `ClrSubject.verifiableCredential` [1..*] carries the **nested, individually signed AchievementCredentials**. `achievement` [0..*] lists the achievements, and `association` [0..*] relates them (`associationType`, `sourceId`, `targetId`) ([CLR2] §B.1.2, §B.1.3). VC-JWT CLRs have a "Sign Nested Credentials" step ([CLR2] §7.2.4.1).
- **(inference)** CLR is the natural "transcript" for a learner who finishes several lessons, a path and a course: one ClrCredential wraps the lesson, path and course badges with `isChildOf`/`isPartOf`-style associations. It is a later phase, not the prototype.

---

## 2. Signing in practice

### 2.1 Proof formats and what each ecosystem accepts

| Format | OB 3.0 spec | 1EdTech conformance | DCC verifier-core (used by LCW, VerifierPlus) | Notes |
| --- | --- | --- | --- | --- |
| VC-JWT, RS256 | Yes, the minimum ([OB3] §8.2.3) | Yes ([OB3-IMPL] §3.1.2) | **Not listed**: Data Integrity suites only (https://github.com/digitalcredentials/verifier-core) | The simplest to implement |
| VC-JWT, EdDSA/ES256 | Permitted, "limits interoperability" ([OB3] §8.2.3) | No | No | |
| DI `eddsa-rdfc-2022` | Yes ([OB3] §8.3) | **Yes** ([OB3-CERT] §3.1.1, §4.2.1) | **Yes** | Needs JSON-LD expansion plus RDFC-1.0 canonicalisation |
| DI `ecdsa-sd-2023` | Yes | Yes (added Jul 2025, [OB3-CERT] rev 1.2) | No (it lists `ecdsa-rdfc-2019`) | Selective disclosure; complex |
| DI `eddsa-jcs-2022` | Not excluded | **No** | **No** | The easiest Data Integrity suite to write; no interop |
| `Ed25519Signature2020`, `eddsa-2022` | Deprecated drafts ([OB3-IMPL] §3.3.1) | No | Verifies legacy `ed25519-signature-2020` | Verifiers should still accept older badges |

**Conclusion (inference):** `eddsa-rdfc-2022` is the only proof format that both 1EdTech and the DCC wallet stack accept.

### 2.2 Keys, identifiers, hosting, rotation

- **Key type:** Ed25519, as a Multikey (`publicKeyMultibase`) for Data Integrity ([OB3] §8.3.1, §B.6.1). An RSA key of 2048 bits or more is needed if RS256 JWT is ever added ([OB3] §8.2.3, which points to IMS Security Framework §6.1).
- **Issuer id options** ([OB3-IMPL] §3.1.1, §2.1):
  - An HTTPS URL that resolves to a Profile.
  - A DID: the guide discusses `did:key`, `did:jwk` and `did:web`. It does not restrict DID methods, but "interoperability depends on the methods … shared".
  - The quickstart suggests an issuer profile at an HTTPS URL tied to a `did:web` as the easy start, and its dual-issuer example uses a `did:web` issuer ([OB3-IMPL] §2.1, §6.1).
- **Why did:web for us:** the DCC document loader resolves only `did:key` and `did:web`, and it fetches remote contexts only when switched on ("not recommended") (https://github.com/digitalcredentials/security-document-loader README).
  - `did:key` has no rotation and no link to a domain, so did:web is the practical choice **(inference)**.
  - did:web is served from `https://<domain>/.well-known/did.json`. The issuer's site name gives trust; nobody else vouches for the issuer.
- **Key provenance** ([OB3-IMPL] §3.1.12):
  - Data Integrity: the verification method's `controller` MUST equal the issuer id.
  - JWT: publish a JWKS at `https://{domain}/.well-known/jwks.json` (media type `application/jwk-set+json`) and make `kid` point into it.
- **Rotation (inference, consistent with the above):**
  - Add the new key to the DID document's `assertionMethod` and start signing with it.
  - **Keep old public keys in the DID document**, or every earlier badge stops verifying.
  - If a key is compromised, remove it and re-issue the affected badges with the same credential `id` and a newer `validFrom` ([OB3] §10). The `refreshService` mechanism lets verifiers pull the new copy ([OB3] §9.1).
- **Key storage:** [OB3-IMPL] §3.1.2 recommends HSMs where possible, notes that some cloud KMS services lack Ed25519, and stresses protecting "application processes that can trigger signing" as much as the keys.

### 2.3 Revocation

- **Use Bitstring Status List** ([BSL], W3C Rec 15 May 2025). The entry in the badge looks like this:

  ```json
  "credentialStatus": {
    "type": "BitstringStatusListEntry",
    "statusPurpose": "revocation",
    "statusListIndex": "<random index>",
    "statusListCredential": "<url>"
  }
  ```

  - Issuers should assign the index **randomly**.
  - The list is itself a **signed** `BitstringStatusListCredential`. Its `encodedList` is GZIP-compressed, then multibase base64url.
  - The uncompressed list must be at least **16 KB (131,072 entries)**, for herd privacy.
  - An optional `ttl` (in ms) should be aligned with `Cache-Control`.
  - Verifiers should cache lists.
- The 1EdTech Revocation List (VCRL-10) is **deprecated** ([OB3] rev 1.3; [CLR2] rev 1.1). The Displayer tests treat a credential as revoked only through a BitstringStatusListEntry with `statusPurpose: "revocation"` ([OB3-CERT] §4.1).
- OB use case §3.13, "Badge Class Status" (invalidate a whole Achievement), is listed but has no mechanism defined ([OB3] §3.13).

### 2.4 What a small server needs to issue safely (inference, from the sources above)

1. One Ed25519 keypair, generated on the server.
   - Store the private key outside the database and web root, for example a `wp-config.php` constant or a file outside `public_html` with 0600 permissions. Never store it in `wp_options`, because database exports leak it.
   - Encrypt it at rest with a key held outside the database.
2. A signing path that only server code can trigger:
   - Signing happens only inside the "satisfied" handler, from statements already stored in the LRS.
   - No REST endpoint signs arbitrary JSON.
   - Rate limiting, plus an audit log of each issuance (credential id, achievement, registration, statement ids).
3. Static, cacheable public documents: `/.well-known/did.json`, the issuer Profile, the Achievement JSON, and the status list credential (re-signed on each revocation).
4. Pinned JSON-LD contexts: bundle `credentials/v2`, `ob/v3p0/context-3.0.3.json` and the extensions context. **Never fetch contexts at runtime**, which is a known Data Integrity attack surface and slow. Run expansion in safe mode so that undefined terms fail at issuance ([OB3-CERT] §3).
5. A test that runs on each release: validate a sample badge in https://vc.1ed.tech and in VerifierPlus (https://github.com/digitalcredentials/verifier-plus; it "supports … version 3 of Open Badges, but NOT version 2").

### 2.5 Libraries: simplest correct option per language

**TypeScript (course server, the course-xapi-mcp reference implementation):**

- `@digitalbazaar/vc` (BSD-3-Clause; pushed Feb 2026): https://github.com/digitalbazaar/vc
- `@digitalbazaar/eddsa-rdfc-2022-cryptosuite` (BSD-3-Clause; pushed Feb 2026): https://github.com/digitalbazaar/eddsa-rdfc-2022-cryptosuite
- `jsonld.js` (Digital Bazaar; pushed Mar 2026): https://github.com/digitalbazaar/jsonld.js
- `@digitalcredentials/security-document-loader` for bundled contexts plus did:key/did:web: https://github.com/digitalcredentials/security-document-loader
- Verify with `@digitalcredentials/verifier-core` (MIT; pushed 21 Oct 2026): https://github.com/digitalcredentials/verifier-core
- For JWT: `jose` by panva (MIT; pushed 21 Oct 2026): https://github.com/panva/jose
- DCC reference services are useful to read, though partly stale:
  - `issuer-coordinator` (MIT; last push Nov 2024): https://github.com/digitalcredentials/issuer-coordinator
  - `signing-service` (MIT; last push Jul 2025): https://github.com/digitalcredentials/signing-service
  - `status-service-db` (MIT; last push Oct 2024): https://github.com/digitalcredentials/status-service-db
- **Verdict: TS is the mature path for `eddsa-rdfc-2022`.**

**PHP (WordPress LRS plugin):**

- Ed25519: `ext-sodium` (`sodium_crypto_sign_detached`) is in PHP core. Bundle the pure-PHP `paragonie/sodium_compat` as a fallback, which php-jwt also recommends (https://github.com/googleapis/php-jwt README).
- **VC-JWT: easy and mature.**
  - `firebase/php-jwt` v7.2.1 (BSD-3-Clause; 28 Sep 2026; RS256 and EdDSA): https://repo.packagist.org/p2/firebase/php-jwt.json and https://github.com/googleapis/php-jwt
  - `web-token/jwt-library` 4.2.3 (MIT; 12 Sep 2026): https://repo.packagist.org/p2/web-token/jwt-library.json
  - `lcobucci/jwt` (BSD-3-Clause; active): https://github.com/lcobucci/jwt
- **`eddsa-rdfc-2022` in PHP: possible, but the libraries are new.**
  - `accredifysg/php-json-ld` v2.2.1 (MIT; repo created May 2026, 0 GitHub stars; requires PHP ^8.2). It provides `toRdf()`: https://github.com/Accredifysg/PHP-JSON-LD
  - `accredifysg/php-rdf-canonicalize` v1.0.0 (MIT; created Jun 2026). It claims to pass 86/86 of the W3C rdf-canon tests and to be "Extracted from accredifysg/verifiable-credentials-php". That package was not found on GitHub or Packagist. https://github.com/Accredifysg/PHP-RDF-Canonicalize
  - `socialweb-php/rdf` (LGPL-3.0; created Sep 2026; RDFC-1.0 with an iteration limit for untrusted input): https://github.com/socialweb-php/rdf
  - The older `ml/json-ld` (MIT) last released in Sep 2022: https://repo.packagist.org/p2/ml/json-ld.json
  - **Catch:** the PHP RDFC stack is months old with no visible adoption. You would have to prove it byte-for-byte against Digital Bazaar on the W3C `vc-di-eddsa` test vectors before trusting it **(inference)**.
- `eddsa-jcs-2022` would be trivial in PHP: RFC 8785 JCS (for example `root23/php-json-canonicalization`, https://packagist.org/search.json?q=rfc8785) plus sodium. But it doesn't interoperate (§2.1).

**Licence compatibility (inference):**

- MIT, BSD-3 and Apache-2.0 libraries can all ship inside a GPL-2.0-or-later plugin.
- LGPL-3.0 (`socialweb-php/rdf`) is GPL-3-compatible, but bundling it in a "GPL-2.0-or-later" plugin effectively makes the combined work GPL-3. That is acceptable under "or later", but worth knowing.
- The Apache-2.0 course-xapi-mcp repo should hold only spec text, schemas and vectors, not GPL code.

**Option worth considering (inference): sign in TypeScript for both pieces.** The WP plugin could call a tiny signing sidecar, but Spacefast allows only WP-CLI-installed plugins, so a Node sidecar is probably not available there. Therefore the realistic options for the plugin are:

- (a) native PHP RDFC, accepting library risk and testing heavily; or
- (b) VC-JWT RS256 in PHP for the prototype, accepting that LCW/VerifierPlus will not verify it. The 1EdTech validator and certification would still pass.

I lean (a), with (b) as a fallback switch.

---

## 3. Wallets, hosts and verifiers today

- **DCC Learner Credential Wallet (LCW)** (MIT; iOS and Android).
  - Release 2.2.10 (June 2026) added the VC-API Interaction URL. It was described as "Our last release as the Digital Credentials Consortium at MIT" (https://github.com/digitalcredentials/learner-credential-wallet README).
  - Stewardship passed to the OpenWallet Foundation (https://openlearning.mit.edu/news/dcc-transfers-stewardship-learner-credential-wallet-openwallet-foundation).
  - The DCC itself moved to Strada Education Foundation in July 2026 and was renamed Digital Credentials Commons (https://www.strada.org/news-insights/strada-announced-as-new-host-for-digital-credentials-consortium; secondary).
  - LCW verifies only Data Integrity proofs (verifier-core, above) and resolves only did:key and did:web (security-document-loader).
  - Forks include ASU Pocket and My Skills Pocket (LCW README).
- **VerifierPlus** (DCC, MIT): verifies VC 1.x and 2.0 including OB 3.0, "but NOT version 2 of Open Badges" (https://github.com/digitalcredentials/verifier-plus).
- **1EdTech public validator** (Apache-2.0): OB 3.0 primarily; for OB 2.0 it recommends `openbadges-validator-core`. Live at https://vc.1ed.tech (https://github.com/1EdTech/digital-credentials-public-validator).
- **Credly (Pearson):** 1EdTech-certified OB **3.0 Issuer** and OB 2.0 Issuer, both certified 2026-01-27 (https://site.imsglobal.org/certifications/credly/credly). It accepts "upload and verification of any badge that conforms to either OpenBadge 2.0 or 3.0" (https://info.credly.com/product/open-badge-3.0).
- **Accredible:** OB 3.0 Issuer (2025-12-22), OB 3.0 Service Consumer (Write) (2026-01-23), and OB 2.0 Issuer (2026-09-29) (https://site.imsglobal.org/certifications/accredible/accredible).
- **Open Badge Factory / Open Badge Passport:** "all badges issued with OBF are now 3.0 badges" as of 30 September. The post is dated 08.10.2025 and updated 29.07.2026. Passport displays both 2.0 and 3.0 (https://openbadgefactory.com/en/your-badges-are-now-open-badges-3-0/).
- **Canvas Credentials (ex-Badgr):** Instructure has announced OB 3.0-compliant micro-credentials. Its community forum now sits under "Parchment Award Digital Badges" (https://community.canvaslms.com/t5/Parchment-Award-Digital-Badges/bd-p/canvas_credentials_discussion/page/2). I found no 2026 documentation of OB 3.0 import into its backpack. **Unconfirmed.**
- **BCdiploma:** announced 1EdTech OB 3.0 certification on 10 Feb 2026 (https://www.bcdiploma.com/en/press-release/bcdiploma-earns-1edtech-open-badges-3-0-certification-strengthening-trust-in-digital-credentials; vendor press release).
- **LinkedIn does not verify Open Badges of any version.** Its "Add to Profile" button for certifications now uses a static URL: "the button no longer carries certificate-specific information, and older customized buttons no longer autofill" (https://www.linkedin.com/help/linkedin/answer/a528030, summarised). Sharing to LinkedIn means "a link back to a verify page" **(inference)**.
- **"Learning Credential Network":** I found no organisation or product by that name tied to Open Badges (search 2026-10-27). The closest match is the DCC (now Digital Credentials Commons). **Ask the owner what was meant.**
- **What still only takes OB 2.0:**
  - Older backpacks and LMS badge displays; for example myCred and other WordPress plugins produce only 2.0 (§5).
  - The 2.0 validator-core tool.
  - A March 2026 vendor article says "Open Badges 2.0 remains the most widely used and accepted standard" in 2026 (https://virtualbadge.io/blog-articles/open-badges-3-0-what-is-the-status-in-2026; vendor).
  - The major hosts (Credly, Accredible, OBF) keep both 2.0 and 3.0 certifications.
- **Is issuing both sensible?** 1EdTech says it is possible and describes how ([OB3-IMPL] §6.1):
  - Serve the same achievement at separate endpoints and ids.
  - Link the OB 3.0 Achievement to the OB 2.0 BadgeClass through `related` (type `https://w3id.org/openbadges#BadgeClass`).
  - "It is not advisable to attempt to publish a combined expression."
  - **Recommendation (inference):** OB 3.0 only for the prototype, with OB 2.0 hosted assertions as a later, optional export for learners whose target system can't read 3.0. OB 2.0 hosted verification depends on the issuer site staying online, and it typically puts a hashed email in a public JSON file, which conflicts with RULES.md §5.

---

## 4. xAPI, cmi5 and badges

### 4.1 Published guidance

- **No current ADL, IEEE or 1EdTech document ties cmi5 satisfaction to badge issuance.** The OB 3.0 spec, implementation guide and CLR 2.0 contain no mention of xAPI (full-text check of [OB3], [OB3-IMPL] and [CLR2] on 2026-10-27). cmi5 Quartz has no badge concept ([CMI5-FIT] §0, §4).
- **The ADL-hosted "xAPI Open Badges Profile"** (`http://specification.openbadges.org/xapi`, generated 2018-09-07; last commit Jan 2020) defines:
  - verb `earned`
  - result extension `…/extensions/badgeassertion` (an object whose `@id` points to a hosted Assertion)
  - extension `…/extensions/badgeclass`
  - attachment usage type `…/attachment/badge` (a baked PNG)

  It was written for OB 1.x/2.0 hosted assertions (https://github.com/adlnet/xapi-authored-profiles/blob/master/open-badges/open-badges.jsonld).
- Verb IRIs vary between sources:
  - The profile uses `http://specification.openbadges.org/xapi/verbs/earned`, which Learning Pool also uses (https://learningpool.zendesk.com/hc/en-us/articles/9517719977245-xAPI-statements-that-Learning-Pool-products-send).
  - An older vocabulary page uses `https://openbadgespec.org/xapi/verbs/earned` (http://ottonomy.github.io/openbadges-specification/xapi/).
- ADL's profile-server authoring guide shows a TLA pattern with the verb `qualified` and a badge activity type under `https://w3id.org/xapi/tla/`. That pattern means "meets requirements, not yet awarded" (https://www.adlnet.gov/guides/xapi-profile-server/authoring-guide/Authoring-Guidance.html, via search summary; the page refused connection on 2026-10-27).
- IEEE P2997 (Enterprise Learner Record): its PAR expiry was listed as 31 Dec 2025, and it does not address VCs (https://standards.ieee.org/ieee/2997/10632/). The IEEE cmi5 work (P9274.3.1) is still an active PAR ([CMI5-FIT] §0).
- **Consequence (inference):** course-xapi-mcp has to define the cmi5-to-badge mapping itself. It can reuse the `earned` verb and the `badgeassertion` result-extension IRIs so that existing LRS reports recognise the statement.

### 4.2 Proposed mapping (inference)

| cmi5 event ([CMI5-FIT] §4.2) | Badge | `achievementType` |
| --- | --- | --- |
| AU moveOn met (passed/completed per moveOn) | lesson badge (optional per lesson) | `Badge` or `Assessment` |
| `satisfied` with block object (a path) | path badge | `LearningProgram` |
| `satisfied` with course object | course badge | `Course` |

- `waived` AUs count as satisfied in cmi5. The standard should let the author decide whether a waived ("Tested Out") lesson earns its *lesson* badge. I'd say no lesson badge for waived lessons, but they still count toward path and course badges.
- After signing, the issuer writes an xAPI statement:
  - actor: the same anonymous actor
  - verb: `earned`
  - object: the Achievement id
  - `result.extensions["http://specification.openbadges.org/xapi/extensions/badgeassertion"] = {"@id": <credential id>}`
  - `context.registration`
  - `context.statement`: a StatementRef to the `satisfied` statement

  This sits outside AU sessions, so it is not a cmi5-defined statement **(inference; cmi5 allowed statements must fall inside a session, [CMI5-FIT] §3.1)**.
- The multi-path conflict (C2 in [CMI5-FIT]) matters here. Make **path badges** the primary signal. A course badge fires only when cmi5 course satisfaction fires, or under an author-declared rule (for example "any one path"), which then has to be the standard's own rule because cmi5 has no "any one of".

### 4.3 Referencing xAPI evidence without leaking personal data

Facts:

- Evidence fields can contain PII. Unless protected, anything in the payload goes out with every share. BBS or SD-JWT selective disclosure is the only in-credential protection, and plain Linked Data proofs don't provide it ([OB3-IMPL] §3.2.1).
- Evidence links "should be immutable" and may be access-controlled ([OB3-IMPL] §3.2.3).
- For embedded data, use a `urn:` id plus a separate property; don't use big data: URIs ([OB3-IMPL] §3.1.11).

Proposed rules (inference):

1. **Never embed statements.** They carry the actor account (a stable cross-course id under RULES.md §6.3), timestamps, and free-text answers.
2. Evidence entry:
   - `type: ["Evidence"]`
   - `id: "urn:uuid:<id of the cmi5 satisfied statement>"`
   - `name` / `narrative`: a human summary, for example "Completed 5 lessons and the final check; scaled score 0.86"
   - `genre: "xAPI statement"`

   A statement UUID reveals nothing on its own. Anyone with LRS access (the issuer) can resolve it, and the learner can match it against their own record.
3. If you want tamper-evidence over the statement set, add a VC DM 2.0 `relatedResource` entry with `digestMultibase` (or `digestSRI`) of the canonical statement list. These terms are defined in the `credentials/v2` context, so they pass safe mode (context checked 2026-10-27, https://www.w3.org/ns/credentials/v2).
   - **Catch:** a digest over predictable content can be brute-forced. Include a per-badge random salt in the hashed material, and keep the salt in the learner's record, not in the badge.
4. Optional `evidence.id` as an HTTPS URL to an **access-controlled** LRS evidence page, which the learner can choose to open to a verifier. Not for the prototype.
5. Put scores in `credentialSubject.result` only when the author opts in. Grades are sensitive ([OB3-IMPL] §3.2.1).
6. **Safe-mode catch:** any custom property (for example `xapiRegistration`) must be defined in a published JSON-LD context. The DCC loader won't fetch unknown contexts by default (security-document-loader README), so a custom context breaks LCW verification. **Use only OB 3.0 and VC 2.0 terms** in the prototype.

---

## 5. WordPress badge plugins

| Plugin | Status | OB version | Licence | Usable as our issuer? |
| --- | --- | --- | --- | --- |
| **BadgeOS** | **Closed on wordpress.org 2023-06-27, "Security Issue"** (API: https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=badgeos); CVE-2023-2171/2172/2173 affect ≤ 3.7.1.6 (https://nvd.nist.gov/vuln/detail/CVE-2023-2172) | 2.0 (via add-on) | GPL | No |
| **WPBadger** | Closed 2022-06-08, permanent, author request (same API, slug `wpbadger`) | 1.x/2.0 | GPL | No |
| **Open Badge Factory** (WP plugin) | Closed 2025-11-25, permanent, author request (same API, slug `open-badge-factory`) | delegated to the OBF SaaS | — | No |
| **myCred** 4.0.3 | Active (updated 2026-10-27, tested 7.1.3, 10k+ installs) | **2.0 only**: `@context https://w3id.org/openbadges/v2`, `verification.type: HostedBadge`, recipient `sha256$` of `user_email + salt` (code: `includes/classes/class.mycred-open-badge.php`, downloaded 2026-10-27 from https://downloads.wordpress.org/plugin/mycred.latest-stable.zip) | GPL-2.0-or-later | No: no signing, OB 2.0, and email-based |
| **GamiPress** 8.1.0 | Active (updated 2026-10-23, tested 7.1.3) | No native issuing. Readme: "Connect your site achievements with Badgr or Credly to issue open badges" (paid add-ons, SaaS) | GPLv3 | No |
| **Accredible Certificates** 1.6.2 | Active, 80 installs | delegated to Accredible SaaS | — | No (SaaS) |
| **open-badges-for-learndash** (LXD-Integral) | GitHub, pushed 2026-10-26, 0 stars | delegated to OBF or CanCred | GPL-2.0 | No (SaaS) |
| **badgefactor2** (ctrlwebinc) | GitHub, pushed 2025-09 | Badgr server | GPL-2.0 | No |

Sources: wordpress.org plugin API queries on 2026-10-27, using the URL pattern above with the slug changed, and GitHub search (https://api.github.com/search/repositories?q=wordpress+%22open+badges%22).

**Finding:** I found no maintained, open-source WordPress plugin that *signs* OB 3.0 credentials itself. Every live option is either OB 2.0 hosted (myCred) or a bridge to a SaaS issuer (Credly, Badgr/Canvas, OBF, Accredible, CanCred). **Our LRS plugin should issue badges itself.**

- Optionally, expose a `do_action( 'course_xapi_badge_issued', … )` hook so that myCred or GamiPress can mirror the award as site gamification **(inference)**.
- The LRS plugin is also the right place in security terms, because it is where satisfaction is computed from tamper-resistant statements (§0.2).

---

## 6. Recipient identity

Constraints:

- OB 3.0 needs a `credentialSubject.id` and/or an `identifier` ([OB3] §9.1).
- Our records use an anonymous `account` actor and forbid email and mbox in statements (RULES.md §5.1, §6.3).
- In an LMS launch, the actor is LMS-assigned ([CMI5-FIT] C3).

| Option | How | Privacy | Verifier experience | Fit |
| --- | --- | --- | --- | --- |
| **A. Learner DID** (`credentialSubject.id = did:key:…`) | The wallet generates it and proves control during issuance (VC-API / OID4VCI). [OB3-IMPL] §2.1: use the DID "if the learner has proven control" | Good: no PII. A single reused DID can be linked across every verifier who sees it; pairwise DIDs avoid that | The holder proves control through a Verifiable Presentation | Best when a wallet is present; the agent itself can't hold the key safely **(inference)** |
| **B. Hashed email** (`identifier: {identityType: "emailAddress", hashed: true, salt, identityHash: "sha256$…"}`) | The learner types an email at claim time; the issuer hashes it with a random per-badge salt | **Weak**: the salt is in the badge, so anyone who guesses the email can confirm it. It hides the email from casual readers only. MD5 is allowed but should not be used ([OB3] §B.8) | The verifier knows the email out of band and recomputes the hash ([OB3] §9.3) | Works without a wallet; this is what LinkedIn-style sharing relies on |
| **C. Plain URL / profile** (`credentialSubject.id = https://site/learners/…`) | The learner opts into a public profile | Public by design | Simple | Opt-in only |
| **D. xAPI account name** (hashed `accountId`) | Hash of the anonymous actor id | **Bad**: it lets anyone who sees the badge, plus anyone with access to the LRS, link the badge to the learner's whole cross-course record (RULES.md §5.2 and §6.3 make that id stable) | Meaningless to an outside verifier | **Reject** |
| **E. LMS-assigned id** (`identityType: "sourcedId"` / `ltiUserId`, hashed) | When an LMS launched the course | Institutional identifiers can be reversed by the institution | Useful only to that institution | Optional, institution mode |

**Recommendation (inference):**

- Default to **claim-time binding**. The badge is issued only when the learner claims it, through a single-use claim link that the agent or MCP server hands out.
- At claim time the learner either connects a wallet, which gives Option A, or enters an email, which gives Option B with a fresh 16-byte random salt.
- Store only the hash and salt in the LRS badge table, never the plain email.
- This keeps xAPI statements PII-free, because the badge identity lives only in the credential.
- Don't issue badges without a recipient. The spec forbids it ([OB3] §9.1), and a bearer badge could be passed to anyone.

---

## 7. Where issuance belongs and what to build

### 7.1 Split of responsibilities (inference, built on §0)

**course-xapi-mcp (Apache-2.0, the standard):**

- Course manifest: `badges[]` per lesson, path or course. Each holds the Achievement fields (`id`, `name`, `description`, `criteria.narrative`, `image`, `achievementType`, optional `alignment[]` and `resultDescription[]`), plus `awardOn` (`au-moveon` | `block-satisfied` | `course-satisfied` | an author rule) and `countWaived`.
- Normative rules:
  - issue only on the listed cmi5 events
  - one badge per achievement per registration
  - the evidence shape from §4.3
  - recipient-binding rules from §6
  - the `earned` statement after issuance
  - "credential MUST conform to OB 3.0 and pass the 1EdTech validator"
  - the proof profile: `eddsa-rdfc-2022` MUST be supported; VC-JWT RS256 MAY be added
  - status MUST use BitstringStatusListEntry
- Test vectors: a signed sample badge, a status list, and a did.json.
- An MCP tool or resource such as `get_badges` / `claim_badge` that returns claim links. **The MCP server never returns a private key or signs on the agent's request.**

**LRS plugin (GPL-2.0-or-later, the issuer for LMS/LRS mode):**

- Issuer Profile, `did:web` document, key management, Achievement JSON endpoints.
- Issue-on-satisfied: hook the LRS's own handling of the stored `satisfied` statement.
- Claim flow, status list, revoke UI, PNG baking, and a public badge page (`/badges/<uuid>`) for LinkedIn and email sharing.

**Course server (TS, the reference implementation):**

- Issues only in standalone mode (no LRS), using the same profile and Digital Bazaar libraries.
- Otherwise it only exposes claim links that the issuer gave it.

### 7.2 Formats to support first

1. OB 3.0 OpenBadgeCredential, VC DM 2.0, `eddsa-rdfc-2022`, did:web, BitstringStatusList, JSON download plus a baked PNG.
2. Next: delivery via VC-API Interaction URL or OID4VCI for LCW and other wallets. The OB 3.0 API (OAuth 2 + DCR) only if a host such as Credly needs push.
3. Later: VC-JWT RS256 envelope, a CLR 2.0 transcript, and an optional OB 2.0 hosted export.

### 7.3 Prototype checklist (Learn WordPress Reimagined on Spacefast)

- [ ] Confirm that `ext-sodium` exists on Spacefast PHP 8.5. Show it in Site Health, since `wp eval` is not allowed. Bundle `paragonie/sodium_compat` as a fallback.
- [ ] Confirm that `/.well-known/did.json` reaches WordPress through a rewrite rule on Spacefast. If the host serves `.well-known` statically, fall back to an HTTPS issuer URL with a JWKS. That still meets the spec, which only requires HTTP URL support ([OB3] §8.5), but LCW will not resolve it.
- [ ] Generate one Ed25519 key with a WP-CLI command (`wp course-xapi badges keygen`). Store it outside the database.
- [ ] Publish: did.json, the issuer Profile, and three Achievements (one lesson, one path, one course).
- [ ] Vendor and pin: `credentials/v2`, `ob/v3p0/context-3.0.3.json`, `ob/v3p0/extensions.json`.
- [ ] PHP signer: Accredify php-json-ld `toRdf` → php-rdf-canonicalize → SHA-256 → Ed25519, following the eddsa-rdfc-2022 proof steps. Unit-test it against the W3C vc-di-eddsa vectors and against Digital Bazaar output for the same input.
- [ ] Issue-on-satisfied hook, the claim page (email-hash path first; wallet path next), and the `earned` xAPI statement.
- [ ] Status list: one 131,072-entry list, random indexes, re-signed on revoke ([BSL]).
- [ ] Public badge page plus PNG baking (`iTXt` keyword `openbadgecredential`, [OB3] §5.3.1). Add a "copy link for LinkedIn" button, because LinkedIn autofill no longer works.
- [ ] Verify in https://vc.1ed.tech, VerifierPlus, and import into LCW.
- [ ] Attribution line naming 1EdTech Open Badges 3.0 in the plugin readme and the standard ([LIC] §3).

### 7.4 Catches, summarised

1. 1EdTech certified only `eddsa-rdfc-2022`, `ecdsa-sd-2023` and RS256 JWT. LCW and DCC accept only Data Integrity. Only `eddsa-rdfc-2022` satisfies both.
2. The PHP RDFC-1.0 and JSON-LD libraries are from 2026 and have no visible adoption. Test them hard, or fall back to JWT.
3. JSON-LD safe mode plus wallet context allow-lists mean no custom properties.
4. The 1EdTech Revocation List is deprecated. Use Bitstring Status List with a list of at least 16 KB.
5. LinkedIn verifies nothing.
6. The 1EdTech licence bars derivative documents. Reference OB 3.0; don't copy it.
7. Certification needs a paid 1EdTech membership at an unpublished price. The free validator is enough to start.
8. No WordPress plugin signs OB 3.0, so we build the issuer.
9. Hashed email is weak privacy, and hashing the xAPI actor would be worse.
10. A badge signed from a learner-editable record proves nothing, so issue from the LRS.
