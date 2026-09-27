import { useEffect, useId, useRef, useState } from "react";

/**
 * A themed dropdown that replaces <select>.
 *
 * WHY THIS EXISTS: the operating system draws a native <select>'s open list. No
 * stylesheet reaches it — not `appearance: none`, not a background colour. So
 * every dropdown opened as a bright system panel in the middle of a violet
 * interface, and on the dark console it was the brightest thing on the page.
 * This renders the list ourselves, in our own layer.
 *
 * WHAT IT MUST NOT LOSE, because a dropdown that drops these is worse than the
 * one it replaced:
 *   - role="combobox" + aria-expanded + aria-haspopup + aria-controls, options as
 *     role="option" with aria-selected, and the active option exposed through
 *     aria-activedescendant so a screen reader follows the highlight.
 *   - Arrow keys move the ACTIVE option, Enter/Space commit, Escape cancels and
 *     returns focus to the button, Home/End jump, Tab closes and keeps value.
 *   - Typing a letter jumps to the next option starting with it.
 *   - Click-outside and scroll close it, and the list flips above the button
 *     when there is no room below.
 *   - Disabled options are announced and cannot be chosen.
 *
 * The button keeps the id and name it had, so labels, form posts and the
 * existing test hooks (`#reg-year`) keep working.
 */
export default function Select({
  id,
  name,
  value,
  onChange,
  options = [],
  placeholder = "Select…",
  disabled = false,
  required = false,
  ariaLabel,
  className = "",
  tone = "console",
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [openUp, setOpenUp] = useState(false);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const listRef = useRef(null);
  const listId = `${id}-listbox`;
  const uid = useId();

  const enabledIndexes = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const selected = options.find((o) => o.value === value);
  const optionId = (i) => `${id}-opt-${uid}-${i}`;

  const commit = (option) => {
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    buttonRef.current?.focus();
  };

  /** Open, placing the list where it actually fits. */
  const show = () => {
    if (disabled) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const below = window.innerHeight - rect.bottom;
      setOpenUp(below < 220 && rect.top > below);
    }
    const at = options.findIndex((o) => o.value === value);
    setActive(enabledIndexes.includes(at) ? at : (enabledIndexes[0] ?? -1));
    setOpen(true);
  };

  // Close on anything that takes the click away, or on a scroll that moved the
  // ANCHOR out from under the list. `capture` catches scrolls in any scrollable
  // ancestor, which is how the console's own panes move.
  //
  // It is deliberately not "close on any scroll": opening the list scrolls the
  // highlighted option into view, and that scroll event arrived here and shut the
  // list the instant it opened — but only when the page happened to need
  // scrolling, which is why it looked intermittent.
  useEffect(() => {
    if (!open) return undefined;
    const atOpen = buttonRef.current?.getBoundingClientRect();
    const onDown = (event) => {
      if (!wrapRef.current?.contains(event.target)) setOpen(false);
    };
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

  // Keep the highlighted option visible by scrolling THE LIST only.
  // `scrollIntoView` would also scroll ancestors — including the page — and that
  // page scroll is exactly what the listener above reacts to.
  useEffect(() => {
    if (!open || active < 0) return;
    const list = listRef.current;
    const node = list?.querySelector(`[data-opt="${active}"]`);
    if (!list || !node) return;
    const top = node.offsetTop - list.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + node.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = top + node.offsetHeight - list.clientHeight;
    }
  }, [open, active]);

  const step = (from, delta) => {
    if (enabledIndexes.length === 0) return -1;
    const pos = enabledIndexes.indexOf(from);
    if (pos === -1) return enabledIndexes[delta > 0 ? 0 : enabledIndexes.length - 1];
    const next = Math.min(enabledIndexes.length - 1, Math.max(0, pos + delta));
    return enabledIndexes[next];
  };

  function onKeyDown(event) {
    const { key } = event;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(key)) {
        event.preventDefault();
        show();
      }
      return;
    }
    switch (key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((i) => step(i, 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((i) => step(i, -1));
        break;
      case "Home":
        event.preventDefault();
        setActive(enabledIndexes[0] ?? -1);
        break;
      case "End":
        event.preventDefault();
        setActive(enabledIndexes[enabledIndexes.length - 1] ?? -1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(options[active]);
        break;
      case "Escape":
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
        break;
      case "Tab":
        setOpen(false);
        break;
      default: {
        // Type-ahead: jump to the next option whose label starts with the key.
        if (key.length !== 1) return;
        const needle = key.toLowerCase();
        const from = Math.max(0, active);
        const rotated = [...options.slice(from + 1), ...options.slice(0, from + 1)];
        const hit = rotated.findIndex(
          (o) => !o.disabled && String(o.label).toLowerCase().startsWith(needle)
        );
        if (hit >= 0) setActive((from + 1 + hit) % options.length);
      }
    }
  }

  const buttonClass =
    tone === "site"
      ? className
      : `${className} border border-line bg-void-raised px-3 py-2 font-mono text-sm text-bone outline-none transition focus:border-violet-bright disabled:opacity-50`;

  const listClass =
    tone === "site"
      ? "absolute left-0 z-50 max-h-64 w-full min-w-[12rem] overflow-auto border border-lavender/30 bg-[#150c22] py-1 shadow-[0_18px_50px_rgba(0,0,0,0.6)]"
      : "absolute left-0 z-50 max-h-64 w-full min-w-[12rem] overflow-auto border border-line bg-void-raised py-1 shadow-[0_18px_50px_rgba(0,0,0,0.6)]";

  const optionIdle =
    tone === "site" ? "px-3 py-2 text-sm tracking-wide text-crystal/70" : "px-3 py-2 font-mono text-sm text-ash";
  const optionActive = tone === "site" ? "bg-lavender/15 text-crystal" : "bg-violet/25 text-bone";
  const optionSelected = tone === "site" ? "text-lavender" : "text-violet-bright";

  return (
    <div className={`relative ${open ? "z-40" : ""}`} ref={wrapRef}>
      <button
        ref={buttonRef}
        id={id}
        name={name}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        aria-required={required || undefined}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-invalid={required && !selected ? true : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        data-select={id}
        data-open={open ? "true" : "false"}
        className={`${buttonClass} flex w-full items-center justify-between gap-2 text-left ${
          open ? (tone === "site" ? "border-lavender/75" : "border-violet-bright") : ""
        }`}
      >
        <span className={selected ? "" : tone === "site" ? "text-crystal/40" : "text-ash/70"}>
          {selected ? selected.label : placeholder}
        </span>
        <span
          aria-hidden
          className={open ? "rotate-180 transition-transform" : "transition-transform"}
        >
          ▾
        </span>
      </button>

      {open ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-labelledby={id}
          className={`${listClass} ${openUp ? "bottom-full mb-1 mt-0" : "mt-1"}`}
          data-select-list={id}
        >
          {options.length === 0 ? (
            <li className={`${optionIdle} italic`}>Nothing to choose from</li>
          ) : null}
          {options.map((option, i) => {
            const isSelected = option.value === value;
            return (
              <li
                key={String(option.value)}
                id={optionId(i)}
                data-opt={i}
                // The committed value, next to the human label: a test (or a
                // screen reader announcing "selected") needs the value, and the
                // label is deliberately longer than the value.
                data-value={String(option.value)}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                onMouseDown={(event) => {
                  // Keep focus on the button so the list does not blur and close
                  // before the value is committed. NOT on pointerdown: committing
                  // there unmounts this <li> mid-gesture, which breaks the click
                  // for anything driving the UI (and for a real user's mouse-up).
                  event.preventDefault();
                }}
                onClick={() => commit(option)}
                onPointerEnter={() => !option.disabled && setActive(i)}
                className={`cursor-pointer ${optionIdle} ${
                  i === active && !option.disabled ? optionActive : ""
                } ${isSelected ? optionSelected : ""} ${option.disabled ? "opacity-40" : ""}`}
              >
                {option.label}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
