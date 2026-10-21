import { disclosureMotion } from "./design-system/motion";
import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";

export function Disclosure({
  open,
  children,
  className,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className="activity-disclosure"
      initial={false}
      animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
      transition={{
        ...disclosureMotion,
        duration: reduced ? 0 : disclosureMotion.duration,
      }}
      inert={!open}
      aria-hidden={!open}
    >
      <div className={className}>{children}</div>
    </motion.div>
  );
}
