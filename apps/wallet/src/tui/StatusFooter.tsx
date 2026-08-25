import { Box, Text } from "ink";
import { t } from "../i18n";
import { C } from "./theme";

export interface StatusFooterProps {
  connectedNodes: number;
  totalNodes: number;
  cols: number;
}


function KeyBadge({ label, hint }: { label: string; hint?: string }) {
  return (
    <Box>
      <Text backgroundColor={C.border} color={C.white} bold>
        {label}
      </Text>
      {hint !== undefined && <Text color={C.gray}> {hint}</Text>}
    </Box>
  );
}





export function StatusFooter({ connectedNodes, totalNodes, cols }: StatusFooterProps) {
  const online = connectedNodes > 0;
  const compact = cols < 72;
  return (
    <Box width="100%" justifyContent="space-between">
      <Box gap={1}>
        {compact ? (
          <>
            <KeyBadge label="Ctrl+B" />
            <KeyBadge label="Ctrl+L" />
            <KeyBadge label="Ctrl+T" />
            <KeyBadge label="←→" />
            <KeyBadge label="Enter" />
            <KeyBadge label="Tab" />
          </>
        ) : (
          <>
            <KeyBadge label="Ctrl+B" hint={t("footer.command")} />
            <KeyBadge label="Ctrl+L" hint={t("footer.lang")} />
            <KeyBadge label="Ctrl+T" hint={t("footer.mouse")} />
            <KeyBadge label="←→" hint={t("footer.view")} />
            <KeyBadge label="↑↓" hint={t("footer.scroll")} />
            <KeyBadge label="Enter" hint={t("footer.action")} />
            <KeyBadge label="Tab" hint={t("footer.form")} />
          </>
        )}
      </Box>
      <Box>
        <Text color={C.gray}>
          P2P {connectedNodes}/{totalNodes}
        </Text>
        <Text> </Text>
        <Text color={online ? C.fg : C.red} bold>
          {online ? t("footer.connected") : t("footer.offline")}
        </Text>
      </Box>
    </Box>
  );
}
