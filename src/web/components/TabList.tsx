import { useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

export interface TabDef<T extends string> {
  value: T;
  label: ReactNode;
}

// An accessible tab group implementing the ARIA tabs pattern with automatic
// activation: role=tablist/tab + aria-selected, roving tabindex (only the
// selected tab is in the Tab order), and Arrow/Home/End keyboard navigation that
// moves focus and selects. Click still works. Styling is supplied by the caller
// via listClassName/tabClassName so existing visuals are unchanged.
export function TabList<T extends string>({
  tabs,
  value,
  onChange,
  listClassName,
  tabClassName,
  ariaLabel,
}: {
  tabs: TabDef<T>[];
  value: T;
  onChange: (v: T) => void;
  listClassName: string;
  tabClassName: string;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const focusTab = (idx: number) => {
    ref.current?.querySelectorAll<HTMLElement>('[role="tab"]')[idx]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent, idx: number) => {
    let next: number;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (idx + 1) % tabs.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (idx - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    onChange(tabs[next].value);
    focusTab(next);
  };

  return (
    <div ref={ref} role="tablist" aria-label={ariaLabel} className={listClassName}>
      {tabs.map((t, idx) => {
        const selected = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={selected ? `${tabClassName} active` : tabClassName}
            onClick={() => onChange(t.value)}
            onKeyDown={(e) => onKeyDown(e, idx)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
