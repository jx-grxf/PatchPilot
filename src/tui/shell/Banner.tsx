import React from "react";
import { Box, Text } from "ink";
import { shortenMiddle } from "../format.js";

export type BannerInfo = {
  version?: string;
  model: string;
  host: string;
  workspace: string;
  columns: number;
};

/**
 * The launch header, printed once into scrollback. It records how the session
 * started; the status bar under the composer is what stays current.
 */
export function Banner(props: BannerInfo): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Text>
        <Text color="cyan" bold>
          PatchPilot
        </Text>
        {props.version ? <Text color="gray"> v{props.version}</Text> : null}
      </Text>
      <Text color="gray" wrap="truncate">
        {props.model} · {props.host}
      </Text>
      <Text color="gray">{shortenMiddle(abbreviateHome(props.workspace), Math.max(20, props.columns - 4))}</Text>
    </Box>
  );
}

export function abbreviateHome(path: string): string {
  const home = process.env.HOME;
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}
