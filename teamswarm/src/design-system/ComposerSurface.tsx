import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";

/** Shared editor shell for Host and member conversations. */
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

/** ChatComposerChin structure from open-claude-ui c1f923a (MIT). */
export function ComposerChin({
  className = "",
  notice,
  children,
}: {
  className?: string;
  notice?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="composer-chin" data-cds="ChatComposerChin">
      {notice && <div className="composer-notice">{notice}</div>}
      <div className={`composer-chin-row ${className}`} data-touch-size>
        {children}
      </div>
    </div>
  );
}
