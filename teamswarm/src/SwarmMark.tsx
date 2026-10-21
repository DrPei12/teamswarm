/** Three paths sharing a centre: the same mark belongs to the workspace and Host. */
export function SwarmMark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`swarm-mark ${className}`}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M16 4.5 26 10.25v5.5L16 10 6 15.75v-5.5L16 4.5Z"
        fill="currentColor"
      />
      <path
        d="m6 17.5 10 5.75 10-5.75V23l-10 5.75L6 23v-5.5Z"
        fill="currentColor"
        opacity=".62"
      />
      <path
        d="m6 17.5 10-5.75 10 5.75-10 5.75L6 17.5Z"
        fill="currentColor"
        opacity=".84"
      />
    </svg>
  );
}
