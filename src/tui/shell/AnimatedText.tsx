import React from "react";
import { Text } from "ink";
import type { UltraMode } from "./ultraModes.js";

/** Rainbow palette for the ultramaxx power mode. */
const rainbowPalette = ["#ff5f7e", "#ff9d3c", "#ffe14a", "#5fe08a", "#4fc6ff", "#9d8bff", "#ff7ad9"];

/**
 * Per-ultra-mode colour gradients. Each mode flows its own palette so the
 * keyword reads at a glance: maxx = hot rainbow, cheap = frugal green,
 * focus = laser cyan, loop = cycling violet.
 */
export const ultraGradients: Record<UltraMode, string[]> = {
  maxx: rainbowPalette,
  cheap: ["#3fae6a", "#5fe08a", "#9fe8b8", "#5fe08a", "#3fae6a"],
  fast: ["#ff8a3d", "#ffd54a", "#fff1a8", "#ffd54a", "#ff8a3d"],
  focus: ["#2f8fd0", "#4fc6ff", "#bdeaff", "#4fc6ff", "#2f8fd0"],
  loop: ["#7a5fff", "#9d8bff", "#c77dff", "#9d8bff", "#7a5fff"],
};

/** Flowing-gradient text for any palette — generalises RainbowText. */
export function GradientText(props: { text: string; palette: string[]; frame: number; bold?: boolean }): React.ReactElement {
  const chars = [...props.text];
  const palette = props.palette.length > 0 ? props.palette : rainbowPalette;
  return (
    <Text bold={props.bold}>
      {chars.map((char, index) => (
        <Text key={`grad-${index}`} color={palette[(index + props.frame) % palette.length]}>
          {char}
        </Text>
      ))}
    </Text>
  );
}

/**
 * Rainbow text with the colors flowing through it — used to render the
 * `ultramaxx` keyword and the spinner verb while ultramaxx mode is active.
 */
export function RainbowText(props: { text: string; frame: number; bold?: boolean }): React.ReactElement {
  const chars = [...props.text];
  return (
    <Text bold={props.bold}>
      {chars.map((char, index) => {
        const color = rainbowPalette[(index + props.frame) % rainbowPalette.length];
        return (
          <Text key={`rainbow-${index}`} color={color}>
            {char}
          </Text>
        );
      })}
    </Text>
  );
}

/** Base, mid and crest of the shimmer: a soft glint, not a colour change. */
const shimmerRamp = ["#8b95a5", "#c4ccd8", "#ffffff"] as const;

/**
 * A three-cell glint that sweeps across the text, then rests. The rest is what
 * makes it read as a heartbeat; a band that never stops looks like a glitch.
 * With motion off it is plain bold text.
 */
export function ShimmerText(props: { text: string; frame: number; animate: boolean }): React.ReactElement {
  const chars = [...props.text];
  if (!props.animate) {
    return <Text bold>{props.text}</Text>;
  }

  const cycle = chars.length + 14;
  const crest = (props.frame % cycle) - 2;
  return (
    <Text bold>
      {chars.map((char, index) => {
        const distance = Math.abs(index - crest);
        const color = distance === 0 ? shimmerRamp[2] : distance <= 2 ? shimmerRamp[1] : shimmerRamp[0];
        return (
          <Text key={`shimmer-${index}`} color={color}>
            {char}
          </Text>
        );
      })}
    </Text>
  );
}
