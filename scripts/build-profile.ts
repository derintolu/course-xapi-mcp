// SPDX-License-Identifier: Apache-2.0
// Writes profile/xapi-profile.jsonld from reference/packages/core/src/xapi/profile.ts.
import { writeFileSync } from 'node:fs';
import { buildProfile } from '../reference/packages/core/src/xapi/profile.ts';

writeFileSync(new URL('../profile/xapi-profile.jsonld', import.meta.url), JSON.stringify(buildProfile(), null, 2) + '\n');
console.log('wrote profile/xapi-profile.jsonld');
