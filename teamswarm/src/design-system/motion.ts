/** Adapted from open-claude-ui (MIT, Caho1). See licenses/open-claude-ui-MIT.txt. */
export const springSnappy = {
  type: "spring" as const,
  stiffness: 320,
  damping: 28,
  mass: 1,
};
export const disclosureMotion = {
  duration: 0.2,
  ease: [0.165, 0.84, 0.44, 1] as const,
};

/** Enter/Escape belong to the IME while a candidate is being composed. */
export function isComposing(event: { isComposing: boolean; keyCode: number }) {
  return event.isComposing || event.keyCode === 229;
}
