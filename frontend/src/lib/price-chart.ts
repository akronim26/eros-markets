import type { Point } from "./live-series";
/** Invalid observations break the line even when two good points are less than 30s apart. */
export function priceSegments(points: Point[]): Point[][] {
  const segments: Point[][] = [];
  let segment: Point[] | undefined;
  for (const point of points) {
    if (point.valid === false || !Number.isFinite(point.v) || point.v < 0 || point.v > 1) { segment = undefined; continue; }
    if (!segment || point.t <= segment.at(-1)!.t || point.t - segment.at(-1)!.t > 30) {
      segment = [];
      segments.push(segment);
    }
    segment.push(point);
  }
  return segments;
}

/** A chart retains historical observations even while execution prices are unavailable. */
export function latestSourceObservation(points: Point[], now: number, readError = false) {
  const point = points.findLast(p => p.valid !== false && Number.isFinite(p.t) && Number.isFinite(p.v) && p.v >= 0 && p.v <= 1);
  const newest = points.at(-1);
  return { point, fresh: !!point && point === newest && now - point.t <= 30 && point.t <= now + 2 && !readError };
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
