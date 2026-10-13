export function BrandImage({ mark = false, alt = "Eros Markets", className = "" }: { mark?: boolean; alt?: string; className?: string }) {
  const asset = mark ? "mark" : "lockup";
  return (
    <span className={`brand-image ${className}`} style={{ aspectRatio: mark ? "1" : "1067.036 / 124.195" }} role={alt ? "img" : undefined} aria-label={alt || undefined} aria-hidden={alt ? undefined : true}>
      {/* eslint-disable @next/next/no-img-element */}
      <img src={`/brand/eros-markets-${asset}-on-dark.svg`} alt="" />
      {/* eslint-enable @next/next/no-img-element */}
    </span>
  );
}
