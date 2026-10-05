"use client";

import { BrandImage } from "./brand-image";

import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { Pause, Play } from "lucide-react";
import styles from "./market-lifecycle.module.css";

const STEPS = [
  { label: "Question", detail: "Start with a YES / NO event.", side: "left", row: 0 },
  { label: "Probability", detail: "The market prices the chance of YES.", side: "left", row: 1 },
  { label: "Position", detail: "Go long or short on the odds.", side: "left", row: 2 },
  { label: "Halt", detail: "Trading stops at the scheduled time.", side: "right", row: 0 },
  { label: "Resolve", detail: "Evidence determines the outcome.", side: "right", row: 1 },
  { label: "Claim", detail: "Claim after settlement is ready.", side: "right", row: 2 },
] as const;

/** Small paired particles share a path, with a softer dot following the leading dot. */
function FlowDots({ path, index, compact }: { path: string; index: number; compact: boolean }) {
  const duration = 4.8 + (index % 3) * 0.45;
  return (
    <g className={styles.packets}>
      {Array.from({ length: compact ? 1 : 2 }, (_, packet) =>
        [0, 1].map((trail) => {
          const begin = -(index * 0.63 + packet * duration / 2) + trail * 0.15;
          return (
            <circle key={`${packet}-${trail}`} r={trail ? 1.5 : 3} fill="var(--color-signal)" opacity={0}>
              <animateMotion path={path} dur={`${duration}s`} begin={`${begin}s`} repeatCount="indefinite" calcMode="paced" />
              <animate attributeName="opacity" values={trail ? "0;0.4;0.4;0" : "0;1;1;0"} keyTimes="0;0.12;0.85;1" dur={`${duration}s`} begin={`${begin}s`} repeatCount="indefinite" />
            </circle>
          );
        }),
      )}
    </g>
  );
}

export function MarketLifecycle() {
  const captionId = useId();
  const root = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const tiltFrame = useRef(0);
  const [width, setWidth] = useState(640);
  const [reduced, setReduced] = useState(true);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const active = hovered ?? focused ?? selected;
  const playing = !reduced && visible && pageVisible && !paused;
  const nodeWidth = Math.min(136, Math.max(80, width * 0.2));
  const hubSize = Math.min(84, Math.max(64, width * 0.13125));
  const center = width / 2;

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReduced(preference.matches);
    const updateVisibility = () => setPageVisible(document.visibilityState === "visible");
    updatePreference();
    updateVisibility();
    preference.addEventListener("change", updatePreference);
    document.addEventListener("visibilitychange", updateVisibility);
    const resize = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    const intersection = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.1 });
    if (root.current) { resize.observe(root.current); intersection.observe(root.current); }
    return () => {
      preference.removeEventListener("change", updatePreference);
      document.removeEventListener("visibilitychange", updateVisibility);
      resize.disconnect();
      intersection.disconnect();
      cancelAnimationFrame(tiltFrame.current);
    };
  }, []);

  useEffect(() => {
    if (playing) svg.current?.unpauseAnimations();
    else {
      svg.current?.pauseAnimations();
      cancelAnimationFrame(tiltFrame.current);
      root.current?.style.setProperty("--tilt-x", "0deg");
      root.current?.style.setProperty("--tilt-y", "0deg");
    }
  }, [playing]);

  const resetTilt = () => {
    cancelAnimationFrame(tiltFrame.current);
    root.current?.style.setProperty("--tilt-x", "0deg");
    root.current?.style.setProperty("--tilt-y", "0deg");
  };
  const followPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (!playing || event.pointerType !== "mouse" || !root.current) return;
    const box = root.current.getBoundingClientRect();
    const x = Math.max(-1, Math.min(1, (event.clientX - box.left) / box.width * 2 - 1));
    const y = Math.max(-1, Math.min(1, (event.clientY - box.top) / 176 * 2 - 1));
    cancelAnimationFrame(tiltFrame.current);
    tiltFrame.current = requestAnimationFrame(() => {
      root.current?.style.setProperty("--tilt-x", `${-y * 4}deg`);
      root.current?.style.setProperty("--tilt-y", `${x * 5}deg`);
    });
  };

  return (
    <div ref={root} className={styles.diagram} role="group" aria-label="Market lifecycle" data-motion={playing ? "on" : "off"} data-active={active !== null ? "true" : "false"}
      onPointerMove={followPointer} onPointerLeave={() => { setHovered(null); resetTilt(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { setSelected(null); setFocused(null); setHovered(null); } }}>
      <div className={styles.canvas}>
        <svg ref={svg} viewBox={`0 0 ${width} 176`} preserveAspectRatio="none" className={styles.connections} aria-hidden>
          {STEPS.map((step, index) => {
            const y = 24 + step.row * 64;
            const left = step.side === "left";
            const fromX = left ? nodeWidth : center + hubSize / 2;
            const toX = left ? center - hubSize / 2 : width - nodeWidth;
            const fromY = left ? y : 88;
            const toY = left ? 88 : y;
            const midpoint = (fromX + toX) / 2;
            const path = `M ${fromX} ${fromY} C ${midpoint} ${fromY}, ${midpoint} ${toY}, ${toX} ${toY}`;
            return (
              <g key={step.label} className={styles.route} data-highlight={active === index ? "true" : "false"}>
                <path d={path} className={styles.track} fill="none" vectorEffect="non-scaling-stroke" />
                <rect x={(left ? fromX : toX) - 2} y={y - 2} width={4} height={4} className={styles.port} />
                {!reduced && <FlowDots path={path} index={index} compact={width < 480} />}
              </g>
            );
          })}
        </svg>
        {STEPS.map((step, index) => (
          <button key={step.label} type="button" className={styles.node} data-side={step.side} data-highlight={active === index ? "true" : "false"}
            style={{ top: 2 + step.row * 64 }} aria-label={`${step.label}: ${step.detail}`} aria-pressed={selected === index}
            onPointerEnter={(event) => { if (event.pointerType === "mouse") setHovered(index); }} onPointerLeave={() => setHovered(null)}
            onFocus={() => setFocused(index)} onBlur={() => setFocused(null)} onClick={() => setSelected(selected === index ? null : index)}>
            <span className={styles.nodeFace}><span className={styles.nodeDot} aria-hidden /><span>{step.label}</span></span>
          </button>
        ))}
        <div className={styles.hub} aria-hidden>
          <span className={styles.halo} /><span className={`${styles.halo} ${styles.haloDelayed}`} />
          <div className={styles.hubFace}>
            <svg className={styles.corners} viewBox="0 0 100 100" fill="none" aria-hidden><path d="M 1 13 V 1 H 13 M 87 1 H 99 V 13 M 99 87 V 99 H 87 M 13 99 H 1 V 87" stroke="currentColor" vectorEffect="non-scaling-stroke" /></svg>
            <BrandImage mark alt="" className={styles.mark} />
          </div>
        </div>
      </div>
      <div className={styles.footer}>
        <p id={captionId} className={styles.caption} data-visible={active !== null ? "true" : "false"} aria-hidden>{active !== null ? STEPS[active].detail : "Explore the market lifecycle."}</p>
        <button type="button" className={styles.pause} disabled={reduced} onClick={() => setPaused(!paused)}
          aria-label={reduced ? "Animation disabled by reduced-motion preference" : paused ? "Play diagram animation" : "Pause diagram animation"}
          title={reduced ? "Reduced motion enabled" : paused ? "Play animation" : "Pause animation"}>
          {paused || reduced ? <Play size={12} aria-hidden /> : <Pause size={12} aria-hidden />}
        </button>
      </div>
    </div>
  );
}
