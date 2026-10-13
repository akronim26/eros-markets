import type { Point } from "./live-series";
import { INDEX_CARRY_SECS } from "./index-carry";
/**
 * Solid-line segments. An invalid reading within the INDEX carry of the last valid one holds that price
 * (display only: the engine still rejects it); past the carry, a stale gap or malformed or reversed
 * history breaks the line.
 */
export function priceSegments(points: Point[]): Point[][] {
  const segments: Point[][] = [];
  let segment: Point[] | undefined;
  let lastValid: Point | undefined;
  for (const point of points) {
    if (point.valid === false) {
      if (segment && lastValid && point.t > segment.at(-1)!.t && point.t - lastValid.t <= INDEX_CARRY_SECS) segment.push({ ...point, valid: true, v: lastValid.v });
      else segment = undefined;
      continue;
    }
    if (!Number.isFinite(point.v) || point.v < 0 || point.v > 1) { segment = undefined; continue; }
    if (!segment || !lastValid || point.t <= segment.at(-1)!.t || point.t - lastValid.t > INDEX_CARRY_SECS) {
      segment = [];
      segments.push(segment);
    }
    segment.push(point);
    lastValid = point;
  }
  return segments;
}

/**
 * Dotted "no valid price" connectors between consecutive valid readings more than the INDEX carry apart
 * (a publisher outage or a long invalid stretch), of any length. They keep the chart visually continuous
 * but are never price: the solid line still breaks, and malformed or reversed history drops the left end.
 */
export function priceBridges(points: Point[]): [Point, Point][] {
  const bridges: [Point, Point][] = [];
  let previous: Point | undefined;
  for (const point of points) {
    if (point.valid === false) continue;
    if (!Number.isFinite(point.t) || !Number.isFinite(point.v) || point.v < 0 || point.v > 1) { previous = undefined; continue; }
    if (previous && point.t > previous.t && point.t - previous.t > INDEX_CARRY_SECS) bridges.push([previous, point]);
    previous = point;
  }
  return bridges;
}

/** A chart retains historical observations even while execution prices are unavailable. */
export function latestSourceObservation(points: Point[], now: number, readError = false) {
  const point = points.findLast(p => p.valid !== false && Number.isFinite(p.t) && Number.isFinite(p.v) && p.v >= 0 && p.v <= 1);
  const newest = points.at(-1);
  return { point, fresh: !!point && point === newest && now - point.t <= INDEX_CARRY_SECS && point.t <= now + 2 && !readError };
}

export function priceReadiness(risk: { indexAvailable: boolean; markAvailable: boolean; pricingMode: number }, sourceFresh: boolean) {
  if (risk.indexAvailable && risk.markAvailable) return undefined;
  if (!risk.indexAvailable) return sourceFresh
    ? "Source prices are arriving. The execution index is still warming up; the chart shows individual source observations."
    : "The execution index is unavailable because recent price history has gaps or stale observations. Any chart price is historical. Live prices must recover before trading can resume.";
  return risk.pricingMode === 0
    ? "The index is ready. The mark is still warming up; leveraged trading waits for complete book and basis windows and normal-pricing activation."
    : "The index is ready, but the mark's book or basis window is unavailable. Higher leverage remains restricted until those windows recover.";
}
