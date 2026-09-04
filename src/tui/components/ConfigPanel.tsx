import React from "react";
import { Box, Text } from "ink";
import type { ModelProvider } from "../../core/types.js";
import {
  filterSettings,
  formatSettingValue,
  isDefaultValue,
  readSettingValue,
  settingGroupLabels,
  settingsForProvider,
  type SettingDefinition,
  type SettingGroup
} from "../settingsRegistry.js";

/**
 * Every setting, searchable, with its current value.
 *
 * The list is a render of the registry rather than a second copy of it, so a
 * setting cannot exist without appearing here. A value that differs from the
 * default is highlighted — the question a config screen actually answers is
 * "what did I change?", not "what is possible".
 */

export type ConfigPanelProps = {
  provider: ModelProvider;
  query: string;
  selectedIndex: number;
  width: number;
  height: number;
  /** Shown under the list when a typed value was rejected. */
  notice?: string | null;
  env?: NodeJS.ProcessEnv;
};

export function visibleSettings(provider: ModelProvider, query: string): SettingDefinition[] {
  return filterSettings(settingsForProvider(provider), query);
}

export function ConfigPanel(props: ConfigPanelProps): React.ReactElement {
  const env = props.env ?? process.env;
  const settings = visibleSettings(props.provider, props.query);
  const rows = Math.max(4, props.height - 4);

  // Keep the selection in view without letting it sit at the very edge.
  const start = Math.max(0, Math.min(props.selectedIndex - Math.floor(rows / 2), settings.length - rows));
  const visible = settings.slice(start, start + rows);

  const nameWidth = Math.min(30, Math.max(14, ...settings.map((setting) => setting.name.length)));
  let lastGroup: SettingGroup | null = null;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>
          settings{" "}
        </Text>
        <Text color="gray" dimColor>
          {props.query ? `“${props.query}” · ` : ""}
          {settings.length} of {settingsForProvider(props.provider).length}
        </Text>
      </Box>

      {settings.length === 0 ? (
        <Text color="gray" dimColor>
          {"  "}nothing matches — try a shorter word, or the env key
        </Text>
      ) : null}

      {visible.map((setting, index) => {
        const absoluteIndex = start + index;
        const selected = absoluteIndex === props.selectedIndex;
        const value = readSettingValue(setting, env);
        const changed = !isDefaultValue(setting, value);
        const groupHeader = setting.group !== lastGroup ? settingGroupLabels[setting.group] : null;
        lastGroup = setting.group;

        return (
          <Box key={setting.key} flexDirection="column">
            {groupHeader && !props.query ? (
              <Text color="gray" dimColor>
                {"  "}
                {groupHeader}
              </Text>
            ) : null}
            <Box>
              <Text color={selected ? "cyan" : "gray"} bold={selected}>
                {selected ? " ▸ " : "   "}
              </Text>
              <Box width={nameWidth}>
                <Text color={selected ? "white" : "gray"} bold={selected} wrap="truncate">
                  {setting.name}
                </Text>
              </Box>
              {/* A changed value is the thing worth finding, so it carries the
                  colour and the default stays quiet. */}
              <Text color={changed ? "yellow" : "gray"} dimColor={!changed} wrap="truncate">
                {" "}
                {formatSettingValue(setting, value)}
              </Text>
            </Box>
          </Box>
        );
      })}

      {settings[props.selectedIndex] ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray" wrap="wrap">
            {"  "}
            {settings[props.selectedIndex]?.description}
          </Text>
          <Text color="gray" dimColor>
            {"  "}
            {settings[props.selectedIndex]?.key}
            {settings[props.selectedIndex]?.appliesNextRun ? " · applies to the next run" : ""}
          </Text>
        </Box>
      ) : null}

      {props.notice ? (
        <Text color="red">
          {"  "}
          {props.notice}
        </Text>
      ) : null}

      <Text color="gray" dimColor>
        {"  ↑↓ move · ⏎ toggle or edit · type to filter · esc closes"}
      </Text>
    </Box>
  );
}
