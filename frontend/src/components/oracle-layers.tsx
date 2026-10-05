"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import Link from "next/link";
import { ArrowRight, Pause, Play } from "lucide-react";
import { OracleScene } from "./oracle-scene";
import styles from "./oracle-layers.module.css";

const LAYERS = [
  { title: "Data feeds", tag: "Chainlink CRE", description: "A listed data source proposes YES or NO after trading halts." },
  { title: "Models + human review", tag: "3 model families · 2-of-3 signers", description: "No usable feed? Independent models assess public evidence. A human committee reviews the proposal." },
  { title: "Open to challenge", tag: "Bonded assertions", description: "Every proposal can be challenged before the outcome becomes final." },
] as const;

/** An architectural illustration, independent of wallet state and live oracle reads. */
export function OracleLayers() {
  const root = useRef<HTMLDivElement>(null);
  const scene = useRef<HTMLDivElement>(null);
  const pointerFrame = useRef(0);
  const [active, setActive] = useState(0);
  const [reduced, setReduced] = useState(true);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [paused, setPaused] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  const playing = !reduced && visible && pageVisible && !paused;

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReduced(motion.matches);
    const updatePage = () => setPageVisible(document.visibilityState === "visible");
    updateMotion();
    updatePage();
    motion.addEventListener("change", updateMotion);
    document.addEventListener("visibilitychange", updatePage);
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.15 });
    if (root.current) observer.observe(root.current);
    return () => {
      motion.removeEventListener("change", updateMotion);
      document.removeEventListener("visibilitychange", updatePage);
      observer.disconnect();
      cancelAnimationFrame(pointerFrame.current);
    };
  }, []);

  useEffect(() => {
    if (!playing || hovering || focused) return;
    const timer = setInterval(() => setActive((value) => (value + 1) % LAYERS.length), 5200);
    return () => clearInterval(timer);
  }, [playing, hovering, focused]);

  function move(event: PointerEvent<HTMLDivElement>) {
    if (!playing || event.pointerType !== "mouse") return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - 0.5;
    const y = (event.clientY - bounds.top) / bounds.height - 0.5;
    cancelAnimationFrame(pointerFrame.current);
    pointerFrame.current = requestAnimationFrame(() => {
      scene.current?.style.setProperty("--oracle-x", `${x * 8}px`);
      scene.current?.style.setProperty("--oracle-y", `${y * 6}px`);
      scene.current?.style.setProperty("--oracle-turn", `${x * 1.5}deg`);
    });
  }

  function resetPointer() {
    cancelAnimationFrame(pointerFrame.current);
    scene.current?.style.removeProperty("--oracle-x");
    scene.current?.style.removeProperty("--oracle-y");
    scene.current?.style.removeProperty("--oracle-turn");
  }

  return (
    <div ref={root} className={styles.root} data-motion={playing ? "on" : "off"} data-reduced={reduced} aria-label="Oracle layers" onPointerEnter={(event) => { if (event.pointerType === "mouse") setHovering(true); }} onPointerLeave={() => { setHovering(false); resetPointer(); }}>
      <div className={styles.toolbar}>
        <span className="label flex items-center gap-2 text-fg-3"><span className={styles.statusMark} aria-hidden />Resolution / explained</span>
        <button type="button" className={styles.motionButton} onClick={() => setPaused(!paused)} disabled={reduced} aria-label={paused ? "Play oracle animation" : "Pause oracle animation"} aria-pressed={paused} title={reduced ? "Animation disabled by reduced-motion preference" : paused ? "Play animation" : "Pause animation"}>
          {paused || reduced ? <Play size={13} aria-hidden /> : <Pause size={13} aria-hidden />}
          <span>{reduced ? "Still" : paused ? "Play" : "Pause"}</span>
        </button>
      </div>
      <div className={styles.content}>
        <div className={styles.visual} onPointerMove={move} onPointerLeave={resetPointer}>
          <div className={styles.registration} aria-hidden><span>EROS / ORACLE</span><span>01 — 03</span></div>
          <div ref={scene} className={styles.scene}>
            <OracleScene active={active} playing={playing} reduced={reduced} onInspect={setActive} />
          </div>
          <span className={styles.visualHint} aria-hidden>Explore the layers <ArrowRight size={12} /></span>
        </div>
        <div className={styles.layers} role="group" aria-label="Explore oracle layers" onFocus={() => setFocused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
          {LAYERS.map((layer, index) => (
            <button key={layer.title} type="button" className={styles.layer} data-active={active === index} aria-pressed={active === index} onPointerEnter={(event) => { if (event.pointerType === "mouse") setActive(index); }} onFocus={() => setActive(index)} onClick={() => setActive(index)}>
              <span className={styles.layerNumber} aria-hidden>0{index + 1}</span>
              <span className={styles.layerText}>
                <span className={styles.layerTag}>{layer.tag}</span>
                <span className={styles.layerTitle}>{layer.title}</span>
                <span className={styles.layerDescription}>{layer.description}</span>
              </span>
              <ArrowRight className={styles.layerArrow} size={16} aria-hidden />
            </button>
          ))}
        </div>
      </div>
      <div className={styles.footer}>
        <p>Claims open after settlement is prepared.</p>
        <Link href="/resolution" className={styles.detailsLink}>View resolution <ArrowRight size={14} aria-hidden /></Link>
      </div>
    </div>
  );
}
