import { useEffect, useRef, useState } from "react";
import { easeInOut, motionEnabled } from "../motion.js";

/**
 * Glides a displayed number to its new value instead of jumping, so a meter
 * that moves reads as a change rather than a redraw. Snaps when motion is off.
 */
export function useTween(target: number, durationMs = 280): number {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  const valueRef = useRef(target);
  valueRef.current = value;

  useEffect(() => {
    if (!motionEnabled() || valueRef.current === target) {
      setValue(target);
      return;
    }

    fromRef.current = valueRef.current;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const t = Math.min(1, (Date.now() - startedAt) / durationMs);
      setValue(fromRef.current + (target - fromRef.current) * easeInOut(t));
      if (t >= 1) {
        clearInterval(timer);
      }
    }, 33);
    return () => clearInterval(timer);
  }, [target, durationMs]);

  return value;
}
