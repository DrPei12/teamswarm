import { useId, useRef } from "react";
import { motion, useReducedMotion } from "motion/react";
import { springSnappy } from "./motion";

/** Sliding selection adapted from open-claude-ui; native buttons and roving focus. */
export function SegmentedControl<T extends string>({
  value,
  label,
  options,
  onChange,
}: {
  value: T;
  label: string;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const focusValue =
    options.find((option) => option.value === value && !option.disabled)
      ?.value ?? options.find((option) => !option.disabled)?.value;
  return (
    <div
      ref={root}
      className="segmented-control"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const available = options.filter((option) => !option.disabled);
        const current = available.findIndex((option) => option.value === value);
        const index =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? available.length - 1
              : (current +
                  (event.key === "ArrowRight" ? 1 : -1) +
                  available.length) %
                available.length;
        if (!available[index]) return;
        onChange(available[index].value);
        root.current
          ?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")
          [index]?.focus();
      }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === focusValue ? 0 : -1}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
        >
          {value === option.value && (
            <motion.span
              className="segmented-thumb"
              layoutId={id}
              transition={reduced ? { duration: 0 } : springSnappy}
            />
          )}
          <span className="segmented-label">{option.label}</span>
        </button>
      ))}
    </div>
  );
}
