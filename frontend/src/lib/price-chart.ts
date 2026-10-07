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
