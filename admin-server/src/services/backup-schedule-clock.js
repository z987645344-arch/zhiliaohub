// Fixed UTC+8 calendar shared by backup and retention, independent of host TZ.
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const UTC_PLUS_8_OFFSET_MS = 8 * 60 * 60 * 1000;
const DEFAULT_LOCAL_TIME = '00:00';

function parseLocalTime(value = DEFAULT_LOCAL_TIME) {
  const match = /^(?:([01]\d|2[0-3])):([0-5]\d)$/.exec(String(value));
  if (!match) throw new Error('Backup schedule local time must use 24-hour HH:MM format.');
  return (Number(match[1]) * 60) + Number(match[2]);
}

function scheduledBoundaryAtOrBefore(now, localTime = DEFAULT_LOCAL_TIME) {
  const shiftedNow = now.getTime() + UTC_PLUS_8_OFFSET_MS;
  const shiftedDayStart = Math.floor(shiftedNow / DAY_MS) * DAY_MS;
  let shiftedBoundary = shiftedDayStart + (parseLocalTime(localTime) * MINUTE_MS);
  if (shiftedBoundary > shiftedNow) shiftedBoundary -= DAY_MS;
  return new Date(shiftedBoundary - UTC_PLUS_8_OFFSET_MS);
}

function nextScheduledAt(now, localTime = DEFAULT_LOCAL_TIME) {
  return new Date(scheduledBoundaryAtOrBefore(now, localTime).getTime() + DAY_MS);
}

module.exports = { MINUTE_MS, UTC_PLUS_8_OFFSET_MS, DEFAULT_LOCAL_TIME,
  parseLocalTime, scheduledBoundaryAtOrBefore, nextScheduledAt };
