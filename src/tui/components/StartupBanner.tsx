import React from "react";
import { Box, Text } from "ink";

export function StartupBanner(props: {
  compact?: boolean;
}): React.ReactElement {
  if (props.compact) {
    return (
      <Box flexDirection="column">
        <Text color="cyan" bold>PatchPilot</Text>
        <Text color="gray">Local-only. Permissioned. Easy to review.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="cyan">        ____       _       _     ____  _ _       _   </Text>
      <Text color="cyan">       |  _ \ __ _| |_ ___| |__ |  _ \(_) | ___ | |_ </Text>
      <Text color="cyan">       | |_) / _` | __/ __| '_ \| |_) | | |/ _ \| __|</Text>
      <Text color="cyan">       |  __/ (_| | || (__| | | |  __/| | | (_) | |_ </Text>
      <Text color="cyan">       |_|   \__,_|\__\___|_| |_|_|   |_|_|\___/ \__|</Text>
      <Text color="gray"> </Text>
      <Text color="cyan">             .------.       Local-only coding agent</Text>
      <Text color="cyan">            /  o  o  \      Permissioned tools</Text>
      <Text color="cyan">           |    __    |     Visible diffs and approvals</Text>
      <Text color="cyan">           |  _|  |_  |</Text>
      <Text color="cyan">           '._\____/_.''    [wrench-ready]</Text>
      <Text color="gray"> </Text>
      <Text color="gray">Start with a task, type /onboarding, or ask what PatchPilot can do.</Text>
    </Box>
  );
}
