// Button with a JS-driven hover style — used where the prototype declares a
// style-hover on an element whose inline styles must be reproduced verbatim
// (declaration order matters: several buttons end with `font:inherit`, which
// resets earlier font-size/weight exactly as it does in the prototype).

import { useState } from 'react';
import type { ButtonHTMLAttributes, CSSProperties } from 'react';

export default function HoverButton({
  hoverStyle,
  style,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { hoverStyle?: CSSProperties }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      {...rest}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={hover && hoverStyle ? { ...style, ...hoverStyle } : style}
    />
  );
}
