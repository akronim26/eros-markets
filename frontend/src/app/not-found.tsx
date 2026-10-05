import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import styles from "./not-found.module.css";

export const metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main className={styles.page}>
      <section className={styles.panel} aria-labelledby="not-found-title">
        <div className={styles.status}>
          <span className="label">Error 404 / Page not found</span>
          <span className={styles.statusMark} aria-hidden />
        </div>

        <div className={styles.content}>
          <div className={styles.visual} aria-hidden="true">
            <span className={styles.code}>4<span>0</span>4</span>
            <svg className={styles.chart} viewBox="0 0 400 120" fill="none">
              <path d="M0 100H400M0 60H400M0 20H400" className={styles.grid} />
              <path d="M0 100H40L75 76H110L145 90L190 44H225L260 60L305 20" className={styles.trace} />
              <path d="M305 20H400" className={styles.missing} />
              <path d="M295 20H315M305 10V30" className={styles.crosshair} />
              <rect x="301" y="16" width="8" height="8" className={styles.point} />
            </svg>
          </div>

          <div className={styles.message}>
            <p className={`label ${styles.eyebrow}`}>A wrong turn. A new direction.</p>
            <h1 id="not-found-title">Off the charts.</h1>
            <p className={styles.description}>
              We couldn’t find this page. Your next market is a click away.
            </p>
            <div className={styles.actions}>
              <Link href="/markets" className={styles.primary}>
                <span className={styles.arrow} aria-hidden><ArrowRight size={18} /></span>
                <span>Explore markets</span>
              </Link>
              <Link href="/" className={styles.home}>
                Back to home <ArrowUpRight size={16} aria-hidden />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
