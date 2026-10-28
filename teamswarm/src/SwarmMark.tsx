import logo16 from "../branding/logo-16.png";
import logo24 from "../branding/logo-24.png";
import logo32 from "../branding/logo-32.png";
import logo48 from "../branding/logo-48.png";
import logo64 from "../branding/logo-64.png";
import logo128 from "../branding/logo-128.png";

const marks = { 16: logo16, 24: logo24, 32: logo32, 48: logo48 };
const retina = { 16: logo32, 24: logo48, 32: logo64, 48: logo128 };

export function SwarmMark({
  className = "",
  size = 24,
}: {
  className?: string;
  size?: keyof typeof marks;
}) {
  return (
    <img
      className={`swarm-mark ${className}`}
      src={marks[size]}
      srcSet={`${marks[size]} 1x, ${retina[size]} 2x`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
