import { forwardRef, type ComponentPropsWithoutRef } from "react";

/** Shared single-boundary composer: all inner controls remain borderless. */
export const ComposerSurface = forwardRef<
  HTMLFormElement,
  ComponentPropsWithoutRef<"form">
>(function ComposerSurface({ className = "", children, ...props }, ref) {
  return (
    <form ref={ref} className={`composer-surface ${className}`} {...props}>
      {children}
    </form>
  );
});
