"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import styles from "./oracle-layers.module.css";

const TRIANGLE = "M 65 45 L 250 55 L 150 156 Z";
const ORBIT = "M 150 35 A 60 60 0 1 1 150 155 A 60 60 0 1 1 150 35";
const CORNERS = "M 0 14 V 0 H 14 M 286 0 H 300 V 14 M 300 176 V 190 H 286 M 14 190 H 0 V 176";

function Packet({ path, duration, begin = 0 }: { path: string; duration: number; begin?: number }) {
  return (
    <g>
      <circle r={6} fill="var(--color-signal)" opacity={0.12}><animateMotion path={path} dur={`${duration}s`} begin={`${begin}s`} repeatCount="indefinite" calcMode="paced" /></circle>
      <circle r={2.5} fill="var(--color-signal)"><animateMotion path={path} dur={`${duration}s`} begin={`${begin}s`} repeatCount="indefinite" calcMode="paced" /></circle>
    </g>
  );
}

export function OracleScene({ active, playing, reduced, onInspect }: { active: number; playing: boolean; reduced: boolean; onInspect: (index: number) => void }) {
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (playing) svg.current?.unpauseAnimations();
    else svg.current?.pauseAnimations();
  }, [playing, reduced]);

  return (
    <svg ref={svg} className={styles.illustration} viewBox="0 0 600 560" aria-hidden="true">
      <g className={styles.stack}>
        <path className={styles.spine} d="M 285 193 L 307 287 L 329 381" />
        {/* Back to front keeps the layered surfaces correctly occluded. */}
        {[2, 1, 0].map((index) => (
          <g key={index} className={styles.plane} data-layer={index} data-active={active === index} onPointerEnter={(event) => { if (event.pointerType === "mouse") onInspect(index); }} onClick={() => onInspect(index)}>
            <g className={styles.float} style={{ "--float-delay": `${index * -2.5}s` } as CSSProperties}>
              <g transform={`matrix(.9 -.55 .42 .74 ${110 + index * 22} ${205 + index * 94})`}>
                <rect className={styles.surface} width={300} height={190} />
                <path className={styles.corners} d={CORNERS} />
                <text className={styles.planeLabel} x={12} y={179}>0{index + 1} / {index === 0 ? "SOURCE" : index === 1 ? "REVIEW" : "CHALLENGE"}</text>
                {index === 0 && (
                  <g>
                    {Array.from({ length: 7 }, (_, row) => (
                      <g key={row} className={styles.dataRow} style={{ "--row-delay": `${row * -0.55}s` } as CSSProperties}>
                        {Array.from({ length: 12 }, (_, column) => <circle key={column} cx={24 + column * 23} cy={22 + row * 22} r={1.3} />)}
                      </g>
                    ))}
                    <g className={styles.scan}>
                      <rect x={18} y={16} width={264} height={18} fill="var(--color-signal)" opacity={0.06} />
                      <path d="M 18 34 H 282" stroke="var(--color-signal)" strokeWidth={0.8} opacity={0.6} />
                    </g>
                    {!reduced && [0, 1, 2].map((row) => <Packet key={row} path={`M 24 ${44 + row * 44} H 277`} duration={5.6} begin={-row * 1.8} />)}
                  </g>
                )}
                {index === 1 && (
                  <g>
                    <path className={styles.network} d={TRIANGLE} />
                    <path className={styles.networkInner} d="M 65 45 L 155 89 L 250 55 M 155 89 L 150 156" />
                    {[[65, 45], [250, 55], [150, 156]].map(([x, y], node) => (
                      <g key={node}>
                        <circle className={styles.nodeRing} cx={x} cy={y} r={12} style={{ "--node-delay": `${node * -1.7}s` } as CSSProperties} />
                        <circle className={styles.modelNode} cx={x} cy={y} r={5} />
                      </g>
                    ))}
                    <rect className={styles.consensus} x={151} y={85} width={8} height={8} />
                    {!reduced && <Packet path={TRIANGLE} duration={7.8} begin={-1.8} />}
                  </g>
                )}
                {index === 2 && (
                  <g>
                    <circle className={styles.orbitOuter} cx={150} cy={95} r={76} />
                    <circle className={styles.orbitTrack} cx={150} cy={95} r={60} />
                    <g className={styles.orbit}>
                      <path d="M 150 35 A 60 60 0 0 1 210 95" fill="none" stroke="var(--color-signal)" strokeWidth={1.5} />
                      <path d="M 150 155 A 60 60 0 0 1 90 95" fill="none" stroke="var(--color-signal)" strokeWidth={1} opacity={0.35} />
                    </g>
                    <path className={styles.crosshair} d="M 144 95 H 156 M 150 89 V 101" />
                    {!reduced && <Packet path={ORBIT} duration={12} begin={-3} />}
                  </g>
                )}
              </g>
            </g>
          </g>
        ))}
      </g>
    </svg>
  );
}
