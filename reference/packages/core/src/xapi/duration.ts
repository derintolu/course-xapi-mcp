// SPDX-License-Identifier: Apache-2.0

/** Milliseconds as an ISO 8601 duration: hours, minutes and seconds, with up to three decimals. */
export function isoDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`duration must be a non-negative number of milliseconds, got ${ms}`);
  const total = Math.round(ms);
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = (total % 60_000) / 1000;
  let out = 'PT';
  if (h) out += `${h}H`;
  if (m) out += `${m}M`;
  if (s || out === 'PT') out += `${s}S`;
  return out;
}

const NUM = String.raw`\d+(?:\.\d+)?`;
const ISO_DURATION = new RegExp(`^P(?!$)(?:${NUM}Y)?(?:${NUM}M)?(?:${NUM}W)?(?:${NUM}D)?(?:T(?=\\d)(?:${NUM}H)?(?:${NUM}M)?(?:${NUM}S)?)?$`);

/** True when `v` is an ISO 8601 duration such as `PT1M` or `P1DT2H3.5S`. */
export const isIsoDuration = (v: unknown): v is string => typeof v === 'string' && ISO_DURATION.test(v);
