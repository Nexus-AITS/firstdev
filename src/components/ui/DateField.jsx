import { useEffect, useMemo, useRef, useState } from "react";

/**
 * A date field the operator can actually use.
 *
 * The roster's From / To filters were `<input type="date">`, which is a
 * perfectly good widget — on the operating system's own light-themed calendar
 * popup, opened on top of a dark console, in a row of filters with no room
 * around it. It also gave no way to jump to "today" or to a common window, so
 * the two most common cases (today, this week) meant reaching for the arrows.
 *
 * Value is a plain calendar day, "YYYY-MM-DD", exactly what the data layer
 * turns into an Asia/Kolkata window. Every date here is handled as CALENDAR
 * arithmetic on those three numbers — never as an instant — because
 * `new Date("2026-09-27")` is midnight UTC and formatting that back can print
 * the 26th in IST. The one place a real instant is unavoidable is "today", and
 * that asks for the IST date directly.
 */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** "2026-09-27" for a local Date, with no timezone maths anywhere. */
function iso(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Parse a plain calendar day into a local Date at midnight. */
function parse(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** "27 Sep 2026", also built from parts so no timezone can shift it. */
function pretty(value) {
  const d = parse(value);
  if (!d) return "";
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
}

/** Today in Asia/Kolkata, as a plain calendar day. */
function todayIso() {
  // en-CA formats as YYYY-MM-DD.
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export default function DateField({
  id,
  value,
  onChange,
  placeholder = "Any date",
  min,
  max,
  tone = "console",
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => {
    const d = parse(value) ?? parse(todayIso());
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [cursor, setCursor] = useState(() => value || todayIso());
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const gridRef = useRef(null);

  const selected = value || "";
  const today = todayIso();

  /* The six weeks the month needs, Monday first. `leading` blanks are rendered
     as empty cells rather than as days from the neighbouring months, so a click
     can never land outside the month on screen. */
  const days = useMemo(() => {
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7; // Sunday = 0 -> Monday-first shift
    const out = [];
    for (let i = 0; i < 42; i += 1) {
      const dayNumber = i - offset + 1;
      const inMonth = dayNumber >= 1 && dayNumber <= new Date(
        view.getFullYear(),
        view.getMonth() + 1,
        0
      ).getDate();
      if (!inMonth) {
        out.push(null);
        continue;
      }
      out.push(iso(new Date(view.getFullYear(), view.getMonth(), dayNumber)));
    }
    // Trim a trailing all-blank week so February does not show six rows.
    while (out.length > 35 && out.slice(35).every((d) => d === null)) out.length = 35;
    return out;
  }, [view]);

  useEffect(() => {
    if (!open) return undefined;
    const atOpen = buttonRef.current?.getBoundingClientRect();
    const onDown = (event) => {
      if (!wrapRef.current?.contains(event.target)) setOpen(false);
    };
    // Only a scroll that MOVES the anchor closes the panel — see the note in
    // Select.jsx: the panel's own "keep the selection visible" scroll used to
    // close it the moment it opened.
    const onScroll = () => {
      const now = buttonRef.current?.getBoundingClientRect();
      if (!now) {
        setOpen(false);
        return;
      }
      const moved =
        Math.abs(now.top - (atOpen?.top ?? now.top)) > 2 ||
        Math.abs(now.left - (atOpen?.left ?? now.left)) > 2;
      const offscreen = now.bottom < 0 || now.top > window.innerHeight;
      if (moved || offscreen) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  // Follow the value if the field is reset from elsewhere (Clear filters).
  useEffect(() => {
    if (open) return;
    const d = parse(value) ?? parse(todayIso());
    setView(new Date(d.getFullYear(), d.getMonth(), 1));
    setCursor(value || todayIso());
  }, [value, open, todayIso]);

  const disabled = (day) => (min && day < min) || (max && day > max);

  const move = (days) => {
    const d = parse(cursor);
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
    const asIso = iso(next);
    setCursor(asIso);
    // Page past a month edge and follow it with the view.
    if (next.getMonth() !== view.getMonth() || next.getFullYear() !== view.getFullYear()) {
      setView(new Date(next.getFullYear(), next.getMonth(), 1));
    }
  };

  function onKeyDown(event) {
    if (!open) {
      if (["ArrowDown", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        move(-1);
        break;
      case "ArrowRight":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-7);
        break;
      case "ArrowDown":
        event.preventDefault();
        move(7);
        break;
      case "PageUp":
        event.preventDefault();
        setView(new Date(view.getFullYear(), view.getMonth() - 1, 1));
        break;
      case "PageDown":
        event.preventDefault();
        setView(new Date(view.getFullYear(), view.getMonth() + 1, 1));
        break;
      case "Enter":
        event.preventDefault();
        if (!disabled(cursor)) {
          onChange(cursor);
          setOpen(false);
          buttonRef.current?.focus();
        }
        break;
      case "Escape":
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
        break;
      default:
        break;
    }
  }

  // The keyboard cursor may be a day outside the visible month.
  useEffect(() => {
    if (!open) return;
    const panel = gridRef.current;
    const node = panel?.querySelector(`[data-day="${cursor}"]`);
    if (!panel || !node) return;
    const top = node.offsetTop - panel.offsetTop;
    if (top < panel.scrollTop) panel.scrollTop = top;
    else if (top + node.offsetHeight > panel.scrollTop + panel.clientHeight) {
      panel.scrollTop = top + node.offsetHeight - panel.clientHeight;
    }
  }, [open, cursor]);

  const triggerClass =
    tone === "site"
      ? "w-full border border-lavender/25 bg-white/[0.03] px-4 py-3 text-sm tracking-wide text-crystal outline-none transition focus:border-lavender/75"
      : "border border-line bg-void-raised px-3 py-2 font-mono text-sm text-bone outline-none transition focus:border-violet-bright";
  const panelClass =
    tone === "site"
      ? "absolute left-0 z-50 mt-1 w-[19rem] border border-lavender/30 bg-[#150c22] p-3 shadow-[0_18px_50px_rgba(0,0,0,0.6)]"
      : "absolute left-0 z-50 mt-1 w-[19rem] border border-line bg-void-raised p-3 shadow-[0_18px_50px_rgba(0,0,0,0.6)]";

  const pick = (day) => {
    if (!day || disabled(day)) return;
    onChange(day);
    setCursor(day);
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        ref={buttonRef}
        id={id}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        data-date-field={id}
        data-value={value || ""}
        data-open={open ? "true" : "false"}
        className={`${triggerClass} flex items-center justify-between gap-2 text-left ${
          open ? (tone === "site" ? "border-lavender/75" : "border-violet-bright") : ""
        }`}
      >
        <span className={value ? "" : tone === "site" ? "text-crystal/40" : "text-ash/70"}>
          {value ? pretty(value) : placeholder}
        </span>
        <span aria-hidden>▦</span>
      </button>

      {open ? (
        <div role="dialog" aria-label="Choose a date" className={panelClass} data-date-panel={id}>
          <div className="flex items-center justify-between">
            <button
              type="button"
              data-date-prev={id}
              onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}
              className="px-2 py-1 text-ash transition hover:text-violet-bright"
            >
              ‹
            </button>
            <p className="font-mono text-sm text-bone" aria-live="polite">
              {MONTHS[view.getMonth()]} {view.getFullYear()}
            </p>
            <button
              type="button"
              data-date-next={id}
              onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}
              className="px-2 py-1 text-ash transition hover:text-violet-bright"
            >
              ›
            </button>
          </div>

          <div className="mt-2 grid grid-cols-7 gap-1 text-center" aria-hidden>
            {WEEKDAYS.map((w) => (
              <span key={w} className="font-mono text-[10px] uppercase tracking-widest text-ash/60">
                {w}
              </span>
            ))}
          </div>

          <div ref={gridRef} className="mt-1 grid grid-cols-7 gap-1" role="grid">
            {days.map((day, i) => {
              if (!day) {
                return <span key={`blank-${i}`} aria-hidden />;
              }
              const off = disabled(day);
              const isSelected = day === selected;
              return (
                <button
                  key={day}
                  type="button"
                  role="gridcell"
                  data-day={day}
                  data-today={day === today ? "true" : undefined}
                  aria-selected={isSelected}
                  aria-disabled={off || undefined}
                  disabled={off}
                  onClick={() => pick(day)}
                  className={`h-8 w-full font-mono text-xs transition ${
                    off
                      ? "cursor-not-allowed text-ash/25"
                      : isSelected
                        ? "bg-violet-bright/25 text-bone"
                        : day === today
                          ? "border border-violet-bright/50 text-violet-bright"
                          : "text-ash hover:bg-violet/25 hover:text-bone"
                  }`}
                >
                  {Number(day.slice(-2))}
                </button>
              );
            })}
          </div>

          {/* The two shortcuts the arrows are otherwise needed for. */}
          <div className="mt-3 flex items-center justify-between border-t border-line pt-2">
            <button
              type="button"
              data-date-today={id}
              onClick={() => pick(today)}
              className="font-mono text-[11px] uppercase tracking-[0.2em] text-ash transition hover:text-violet-bright"
            >
              Today
            </button>
            <button
              type="button"
              data-date-clear={id}
              onClick={() => {
                onChange("");
                setOpen(false);
                buttonRef.current?.focus();
              }}
              className="font-mono text-[11px] uppercase tracking-[0.2em] text-ash transition hover:text-violet-bright"
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
