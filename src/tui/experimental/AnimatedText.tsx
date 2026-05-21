import React from "react";
import { Text } from "ink";

/** Orange base + white crest, used for normal run-status verbs. */
const WAVE_BASE = "#f6a13d";
const WAVE_CREST = "#ffffff";
const WAVE_GLOW = "#ffd9a0";

/** Rainbow palette for the ultramaxx power mode. */
export const rainbowPalette = ["#ff5f7e", "#ff9d3c", "#ffe14a", "#5fe08a", "#4fc6ff", "#9d8bff", "#ff7ad9"];

/**
 * Text with a highlight "wave" travelling through it: the verb stays in its
 * base color while a bright crest sweeps across the characters.
 */
export function WaveText(props: {
  text: string;
  frame: number;
  bold?: boolean;
  base?: string;
  crest?: string;
  glow?: string;
}): React.ReactElement {
  const chars = [...props.text];
  const base = props.base ?? WAVE_BASE;
  const crest = props.crest ?? WAVE_CREST;
  const glow = props.glow ?? WAVE_GLOW;
  const span = chars.length + 6;
  const head = ((props.frame % span) + span) % span;

  return (
    <Text bold={props.bold}>
      {chars.map((char, index) => {
        const distance = head - index;
        const color = distance === 0 ? crest : distance === 1 || distance === -1 ? glow : base;
        return (
          <Text key={`wave-${index}`} color={color}>
            {char}
          </Text>
        );
      })}
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
