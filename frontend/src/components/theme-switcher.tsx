"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type ThemePreference } from "./theme-provider";
import { cx } from "./ui";

const OPTIONS = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
] as const;

export function ThemeSwitcher() {
  const { preference, setPreference } = useTheme();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const active = OPTIONS.find((option) => option.value === preference)!;

  useEffect(() => {
    if (!open) return;
    container.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  function choose(value: ThemePreference) {
    setPreference(value);
    setOpen(false);
    trigger.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const items = Array.from(container.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
      const index = items.findIndex((item) => item === document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  }

  return (
    <div ref={container} className="relative shrink-0 max-sm:static" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <button ref={trigger} type="button" aria-label={`Theme: ${active.label}`} title={`Theme: ${active.label}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        className="flex h-11 w-10 items-center justify-center text-fg-3 hover:bg-hover hover:text-fg"
        onClick={() => setOpen(!open)} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}>
        <active.Icon size={17} strokeWidth={1.6} aria-hidden />
      </button>
      {open && (
        <div id={id} role="menu" aria-label="Color theme" onKeyDown={onKeyDown} className="frame absolute right-0 top-full z-50 mt-2 w-44 bg-panel p-1 shadow-[4px_4px_0_var(--color-line)]">
          {OPTIONS.map(({ value, label, Icon }) => (
            <button key={value} type="button" role="menuitemradio" aria-checked={preference === value} tabIndex={-1} onClick={() => choose(value)}
              className={cx("flex min-h-11 w-full items-center gap-3 px-3 text-left text-xs hover:bg-hover", preference === value ? "bg-hover text-fg" : "text-fg-3")}>
              <Icon size={15} strokeWidth={1.6} aria-hidden />{label}
              {preference === value && <Check size={13} className="ml-auto text-signal-text" aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
