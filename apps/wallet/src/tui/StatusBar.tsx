import { Box, Text } from "ink";
import { formatNumber } from "../utils/display";
import { trimEDX } from "../utils/amount";
import { COIN_TICKER } from "../utils/constants";
import { modeButtonLabel, type UiMode } from "./views";
import { LANG_BUTTON_LABEL, t, type Lang } from "../i18n";
import { C } from "./theme";
import type { ChainInfoView } from "../api/types";
import type { WalletConfig } from "../config/config";

export interface StatusBarProps {
  chain: ChainInfoView | null;
  balance: string | null;
  config: WalletConfig;
  mouseOn: boolean;
  mode: UiMode;
  lang: Lang;
  onToggleMode: () => void;

  onToggleLang: () => void;

  connectedNodes: number;

  totalNodes: number;
}


export function StatusBar({ chain, balance, config, mouseOn, mode, lang, onToggleMode, onToggleLang, connectedNodes, totalNodes }: StatusBarProps) {
  const nodeColor = connectedNodes > 0 ? C.fg : C.red;

  const syncStatus = chain?.syncStatus ?? "none";
  const pct = chain ? (chain.syncProgress * 100).toFixed(1) : "0.0";
  let heightText: string;
  let heightColor: string = C.gray;
  if (!chain) {
    heightText = "-- / --";
  } else if (syncStatus === "error") {
    heightText = `✗ ${t("sync.error")}`;
    heightColor = C.red;
  } else if (syncStatus === "synced") {
    heightText = `✓ ${formatNumber(chain.localHeight)} / ${formatNumber(chain.backendHeight)} (${pct}%) ${t("sync.synced")}`;
    heightColor = C.fg;
  } else {
    heightText = `⟳ ${formatNumber(chain.localHeight)} / ${formatNumber(chain.backendHeight)} (${pct}%) ${t("sync.syncing")}`;
    heightColor = C.amber;
  }
  const phaseText = chain
    ? t("ui.phaseShort", { phase: chain.phase, reward: trimEDX(chain.blockReward), ticker: COIN_TICKER })
    : t("ui.phaseShortNone");

  return (
    <Box flexDirection="column" width="100%">
      <Box>
        <Text bold color={C.fg}>{t("ui.walletTitle")}</Text>
        <Text color={C.grayDim}>{t("ui.p2pNodes")}</Text>
        <Text color={nodeColor} bold>{connectedNodes}/{totalNodes}</Text>
        <Text color={C.grayDim}>{t("ui.height")}</Text>
        <Text bold color={heightColor}>{heightText}</Text>
        <Text color={C.grayDim}>{t("ui.balance")}</Text>
        <Text color={balance !== null ? C.fg : undefined} bold>{balance === null ? "--" : `${trimEDX(balance)} ${COIN_TICKER}`}</Text>
      </Box>
      <Box>
        <Text color={C.gray}>{phaseText}</Text>
        <Text color={C.grayDim}>{t("ui.rpc", { port: config.rpcport ?? t("ui.rpcUnset") })}</Text>
        <Text color={mouseOn ? C.cyan : C.gray} dimColor>
          {mouseOn ? t("ui.mouseOn") : t("ui.mouseOff")}
        </Text>
        <Box flexGrow={1} />
        <Text> </Text>
        <Text backgroundColor={C.border} color={C.white} bold>{LANG_BUTTON_LABEL[lang]}</Text>
        <Text> </Text>
        <Text backgroundColor={C.fg} color="#000000" bold>{modeButtonLabel(mode)}</Text>
      </Box>
    </Box>
  );
}
