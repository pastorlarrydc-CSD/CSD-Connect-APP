// IRS standard business mileage rate, by effective date.
//
// This is reference info only, not tax advice -- rates can change
// mid-year (2026 is a good example: 72.5 cents/mile from Jan 1, then an
// unusual mid-year bump to 76 cents/mile effective July 1 after a spike in
// gas prices). Always confirm the current rate and your own situation with
// a tax professional before filing or requesting reimbursement.
//
// Source: IRS Newsroom, "IRS sets 2026 business standard mileage rate at
// 72.5 cents per mile" and the mid-2026 update to 76 cents/mile effective
// July 1, 2026.
const RATE_SCHEDULE = [
  { effectiveFrom: "2026-01-01", centsPerMile: 72.5 },
  { effectiveFrom: "2026-07-01", centsPerMile: 76 },
];

// Returns the IRS standard mileage rate (in dollars per mile) that applied
// on a given date. Falls back to the most recent known rate for dates
// after the schedule, and the earliest known rate for dates before it.
export function mileageRateForDate(dateStr) {
  const date = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();
  let applicable = RATE_SCHEDULE[0];
  for (const entry of RATE_SCHEDULE) {
    if (date >= new Date(`${entry.effectiveFrom}T00:00:00`)) {
      applicable = entry;
    }
  }
  return applicable.centsPerMile / 100;
}

export function estimateReimbursement(miles, dateStr) {
  if (miles == null) return null;
  return miles * mileageRateForDate(dateStr);
}
