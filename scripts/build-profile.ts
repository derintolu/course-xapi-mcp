// Writes profile/xapi-profile.jsonld from packages/core/src/profile.ts.
import { writeFileSync } from 'node:fs';
import { buildProfile } from '../packages/core/src/profile.ts';

writeFileSync(new URL('../profile/xapi-profile.jsonld', import.meta.url), JSON.stringify(buildProfile(), null, 2) + '\n');
console.log('wrote profile/xapi-profile.jsonld');
