// Multi-day trip rebalancer (Session 13).
//
// The per-day optimizer in routeOptimizer.js sequences the stops *within*
// a single day. This module solves a different problem: given a trip that
// already spans multiple days, which day should each stop belong to so the
// combined mileage across every day is as small as possible -- without
// abandoning the days the coach already committed to.
//
// Every day is treated as its own round trip from the same trip-level
// start/end point (trips don't chain day-to-day -- see trips.start_lat/lon
// and end_lat/lon in the schema, reused for every day). Fixed appointments
// (is_fixed_appointment) are anchors: they never move to a different day,
// because the coach has already committed to being at that school on that
// day. Only flexible stops are candidates for relocation.
//
// A pure "minimize total mileage" objective with no other constraint has a
// degenerate optimum: cram every stop into one day and leave the other
// days empty (one big loop from home base beats several smaller ones).
// That's mathematically correct and practically useless -- a coach picked
// multiple days because they only have so many drivable/visitable hours
// per day, not because they wanted the shortest possible total odometer
// reading. So every day keeps a stop-count cap (maxStopsPerDay, default
// auto-derived from the current trip so no single day can swallow the
// rest) and can never be emptied out entirely by the algorithm.
//
// Algorithm: local search over day assignment, with day_number as the one
// and only source of truth (deliberately -- an earlier version kept a
// parallel Map of day -> stop array alongside the day_number field, and
// stale snapshots of that Map caused stops to get silently duplicated or
// dropped once a stop had already moved once in the same pass. Always
// deriving "which stops are on day X" by filtering on day_number avoids
// that class of bug entirely, at the cost of an O(n) filter per lookup --
// cheap at the trip sizes this runs on, tens of stops at most).
//
//   1. Baseline = current day assignment, each day's mileage computed by
//      running the existing 2-opt/Or-opt optimizeRoute on that day's stops.
//   2. Relocate pass: for every flexible stop, try moving it to every other
//      day (by changing its day_number), skipping any day already at cap.
//      Keep the move if it lowers combined mileage of the origin and
//      destination days AND doesn't leave the origin day at zero stops
//      while other stops remain unassigned to it (a day may only end up
//      empty if it started empty).
//   3. Swap pass: for every pair of flexible stops currently on different
//      days, try trading their day_number values (a swap never changes
//      either day's stop count, so it's exempt from the cap/empty checks).
//      Catches beneficial trades a one-way relocation can't reach alone.
//   4. Repeat relocate+swap passes until a full pass makes no improving
//      move, or an iteration cap is hit.
//
// Validated in sandbox testing against:
//  - synthetic scrambled-cluster data (stops pre-shuffled across days
//    against their true geographic cluster)
//  - real DFW-area school coordinates (Dallas/Fort Worth), stops shuffled
//    across a 3-day trip
//  - fixed appointments confirmed to stay pinned to their original day in
//    both tests, no day emptied out, and a consistency check confirming
//    every stop in the final assignment appears in exactly one day's
//    perDay list (no duplication or loss)

import { optimizeRoute } from "./routeOptimizer";

function isFixed(stop) {
  return !!stop.is_fixed_appointment;
}

function dayMiles(start, dayStops, end) {
  if (!dayStops.length) return 0;
  return optimizeRoute({ start, stops: dayStops, end }).totalMiles;
}

// stops: array of { id, lat, lon, day_number, is_fixed_appointment, ... }
// start, end: { lat, lon } -- the trip's shared start/end location
// maxStopsPerDay: optional cap; defaults to enough slack above a perfectly
//   even split that real redistribution can happen, without letting one
//   day absorb everything.
// Returns:
//   assignment: { [stopId]: newDayNumber }
//   perDay: { [dayNumber]: { stops: [orderedStopObjects], miles } }
//   totalBefore, totalAfter, changed, iterations
export function rebalanceTrip({ start, end, stops, maxStopsPerDay, maxIterations = 25 }) {
  if (!stops || stops.length === 0) {
    return { assignment: {}, perDay: {}, totalBefore: 0, totalAfter: 0, changed: false, iterations: 0 };
  }

  const dayNumbers = Array.from(new Set(stops.map((s) => s.day_number))).sort((a, b) => a - b);

  // Work on clones so we never mutate caller-owned (e.g. React state) objects.
  const working = stops.map((s) => ({ ...s }));

  const cap =
    maxStopsPerDay ??
    Math.max(
      Math.ceil(working.length / dayNumbers.length) + 1,
      ...dayNumbers.map((d) => working.filter((s) => s.day_number === d).length)
    );

  const stopsForDay = (d) => working.filter((s) => s.day_number === d);
  const countForDay = (d) => stopsForDay(d).length;
  const milesFor = (d) => dayMiles(start, stopsForDay(d), end);
  const totalMilesNow = () => dayNumbers.reduce((sum, d) => sum + milesFor(d), 0);

  const totalBefore = totalMilesNow();

  const originallyNonEmpty = new Set(dayNumbers.filter((d) => countForDay(d) > 0));

  const buildResult = (iterations) => {
    const perDay = {};
    for (const d of dayNumbers) {
      const opt = optimizeRoute({ start, stops: stopsForDay(d), end });
      perDay[d] = { stops: opt.stops, miles: opt.totalMiles };
    }
    const assignment = {};
    working.forEach((s) => (assignment[s.id] = s.day_number));
    const totalAfter = dayNumbers.reduce((sum, d) => sum + perDay[d].miles, 0);
    return {
      assignment,
      perDay,
      totalBefore,
      totalAfter,
      changed: totalAfter < totalBefore - 1e-6,
      iterations,
    };
  };

  // Single-day trips (or trips with only one day of stops) have nothing to
  // rebalance -- short-circuit rather than doing pointless work.
  if (dayNumbers.length < 2) {
    return buildResult(0);
  }

  let improved = true;
  let iterations = 0;

  while (improved && iterations < maxIterations) {
    improved = false;
    iterations++;

    // --- Relocate pass: move one flexible stop to a different day ---
    for (const stop of working) {
      if (isFixed(stop)) continue;
      const homeDay = stop.day_number;
      for (const d2 of dayNumbers) {
        if (d2 === homeDay) continue;
        if (countForDay(d2) >= cap) continue; // destination already at capacity
        if (originallyNonEmpty.has(homeDay) && countForDay(homeDay) <= 1) continue; // would empty out a day the coach was using

        const before = milesFor(homeDay) + milesFor(d2);
        stop.day_number = d2;
        const after = milesFor(homeDay) + milesFor(d2);
        if (after < before - 1e-6) {
          improved = true;
          break; // this stop found a better day; move on to the next stop
        } else {
          stop.day_number = homeDay; // revert
        }
      }
    }

    // --- Swap pass: trade two flexible stops' days ---
    // A swap never changes either day's stop count, so the cap/empty-day
    // guards above don't apply here.
    const flexStops = working.filter((s) => !isFixed(s));
    for (let i = 0; i < flexStops.length; i++) {
      for (let j = i + 1; j < flexStops.length; j++) {
        const s1 = flexStops[i];
        const s2 = flexStops[j];
        if (s1.day_number === s2.day_number) continue;
        const d1 = s1.day_number;
        const d2 = s2.day_number;
        const before = milesFor(d1) + milesFor(d2);
        s1.day_number = d2;
        s2.day_number = d1;
        const after = milesFor(d1) + milesFor(d2);
        if (after < before - 1e-6) {
          improved = true;
        } else {
          // revert
          s1.day_number = d1;
          s2.day_number = d2;
        }
      }
    }
  }

  return buildResult(iterations);
}
