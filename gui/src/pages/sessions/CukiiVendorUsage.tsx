import { ChevronRightIcon, XMarkIcon } from "@heroicons/react/16/solid";
import { brokerVendorForModel } from "core/cukiiPermissionModes";
import {
  cukiiVendorLabel,
  type BrokerVendorId,
} from "core/cukiiVendorRegistry";
import type {
  BrokerModel,
  CukiiVendorUsageSnapshot,
  CukiiVendorUsageWindow,
} from "core/protocol/ideWebview";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import styled from "styled-components";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useWebviewListener } from "../../hooks/useWebviewListener";

const COLLAPSED_KEY = "cukii.vendor-usage.collapsed.v1";

const Section = styled.section`
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
`;
const SectionHeader = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  border-top: 1px solid var(--vscode-panel-border);
`;
const SectionToggle = styled.button`
  display: flex;
  min-width: 0;
  max-width: 100%;
  height: 26px;
  flex: 1 0 auto;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
`;
const Chevron = styled(ChevronRightIcon)<{ $expanded: boolean }>`
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--vscode-descriptionForeground);
  transform: ${({ $expanded }) => ($expanded ? "rotate(90deg)" : "none")};
`;
const SectionLabel = styled.span`
  overflow: hidden;
  color: var(--vscode-descriptionForeground);
  font-size: 0.85em;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
`;
const SectionLink = styled.button`
  min-height: 26px;
  flex-shrink: 0;
  margin-left: 20px;
  padding: 0 8px;
  border: 0;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  font-family: inherit;
  font-size: 0.85em;
  opacity: 0.8;
  text-decoration: underline;
`;
const Body = styled.div`
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 10px 12px;
`;
const BodySection = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;
const BodyTitle = styled.h4`
  margin: 0;
  color: var(--vscode-foreground);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.5px;
  opacity: 0.7;
  text-transform: uppercase;
`;
const AccountInfo = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`;
const AccountRow = styled.div`
  display: grid;
  min-width: 0;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px;
  color: var(--vscode-foreground);
  font-size: 13px;
`;
const AccountValue = styled.span`
  min-width: 0;
  overflow-wrap: anywhere;
  text-align: right;
`;
/**
 * Причина, по которой строка аккаунта ничего не говорит. Отдельной строкой, а не
 * подсказкой при наведении: владелец видит блок глазами, а не мышью, и «Account
 * status unavailable» без причины — тупик (наблюдение 22.09.2026 у grok).
 */
const AccountDetail = styled.div`
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  overflow-wrap: anywhere;
`;
const UsageBars = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
`;
const UsageBar = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`;
const UsageHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
`;
const UsageText = styled.span`
  color: var(--vscode-foreground);
  font-size: 13px;
`;
const UsagePercent = styled(UsageText)`
  font-variant-numeric: tabular-nums;
`;
const UsageTrack = styled.div`
  height: 6px;
  overflow: hidden;
  border-radius: 3px;
  background: color-mix(in srgb, var(--vscode-foreground) 20%, transparent);
`;
const UsageFill = styled.div<{ $width: number }>`
  width: ${({ $width }) => $width}%;
  height: 100%;
  border-radius: 3px;
  background: var(--vscode-progressBar-background);
  transition: width 0.2s;
`;
const ResetText = styled.div`
  color: var(--vscode-foreground);
  font-size: 11px;
  opacity: 0.5;
`;
const DetailsRoot = styled.main`
  min-height: 100vh;
  box-sizing: border-box;
  display: grid;
  place-items: center;
  padding: 24px;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
`;
const DetailsCard = styled.div`
  position: relative;
  width: min(434px, 100%);
  box-sizing: border-box;
  padding: 20px 16px;
  border: 1px solid var(--vscode-focusBorder);
  border-radius: 8px;
  background: var(
    --vscode-editorWidget-background,
    var(--vscode-sideBar-background)
  );

  ${Body} {
    padding: 0;
  }
`;
const DetailsTitle = styled.h2`
  margin: 0 28px 18px 0;
  font-size: 16px;
  font-weight: 600;
`;
const DetailsClose = styled.button`
  position: absolute;
  top: 14px;
  right: 14px;
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  opacity: 0.7;

  &:hover {
    background: var(--vscode-toolbar-hoverBackground);
    opacity: 1;
  }

  svg {
    width: 16px;
    height: 16px;
  }
`;
const DetailsVendor = styled.div`
  margin-bottom: 16px;
  color: var(--vscode-descriptionForeground);
  font-size: 13px;
`;

function clampedPercent(window: CukiiVendorUsageWindow): number {
  return Math.max(0, Math.min(100, Math.round(window.utilization * 100)));
}

export function resetCopy(resetsAt?: number, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const remaining = Math.max(0, resetsAt * 1_000 - now);
  const hours = Math.ceil(remaining / 3_600_000);
  if (hours >= 48) return `Resets in ${Math.ceil(hours / 24)}d`;
  if (hours >= 1) return `Resets in ${hours}h`;
  return `Resets in ${Math.max(1, Math.ceil(remaining / 60_000))}m`;
}

function UsageContents({ snapshot }: { snapshot: CukiiVendorUsageSnapshot }) {
  // Причина без ярлыка — всё ещё ответ на вопрос «что с аккаунтом»; прятать её
  // из-за пустого accountLabel значило бы снова показать пустоту.
  const showAccount = Boolean(snapshot.accountLabel ?? snapshot.statusDetail);
  const showUsage = snapshot.windows.length > 0;
  if (!showAccount && !showUsage) return null;
  return (
    <Body data-testid="cukii-vendor-usage-body">
      {showAccount && (
        <BodySection>
          <BodyTitle>Account</BodyTitle>
          <AccountInfo>
            {snapshot.accountLabel && (
              <AccountRow>
                <span>
                  {snapshot.accountLabel.includes("@") ? "Email" : "Account"}
                </span>
                <AccountValue>{snapshot.accountLabel}</AccountValue>
              </AccountRow>
            )}
            {snapshot.statusDetail && (
              <AccountDetail
                data-testid="cukii-vendor-usage-status-detail"
                title={snapshot.statusDetail}
              >
                {snapshot.statusDetail}
              </AccountDetail>
            )}
          </AccountInfo>
        </BodySection>
      )}
      {showUsage && (
        <BodySection>
          <BodyTitle>Usage</BodyTitle>
          <UsageBars>
            {snapshot.windows.map((window) => {
              const percent = clampedPercent(window);
              const reset = resetCopy(window.resetsAt);
              return (
                <UsageBar
                  key={window.id}
                  data-testid={`cukii-usage-${window.id}`}
                >
                  <UsageHeader>
                    <UsageText>{window.label}</UsageText>
                    <UsagePercent>{percent}%</UsagePercent>
                  </UsageHeader>
                  <UsageTrack>
                    <UsageFill
                      $width={percent}
                      role="progressbar"
                      aria-label={window.label}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent}
                    />
                  </UsageTrack>
                  {reset && <ResetText>{reset}</ResetText>}
                </UsageBar>
              );
            })}
          </UsageBars>
        </BodySection>
      )}
    </Body>
  );
}

function useVendorUsage(vendor: BrokerVendorId | undefined) {
  const messenger = useContext(IdeMessengerContext);
  const [snapshot, setSnapshot] = useState<CukiiVendorUsageSnapshot | null>(
    null,
  );
  const requestSequence = useRef(0);
  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    if (!vendor) {
      setSnapshot(null);
      return;
    }
    const result = await messenger.request("cukii/getVendorUsage", { vendor });
    if (
      sequence === requestSequence.current &&
      result.status === "success" &&
      result.content.vendor === vendor
    ) {
      setSnapshot(result.content);
    }
  }, [messenger, vendor]);
  useEffect(() => {
    setSnapshot(null);
    void load();
    return () => {
      requestSequence.current += 1;
    };
  }, [load]);
  useWebviewListener(
    "cukii/vendorUsageChanged",
    async (next) => {
      if (next.vendor !== vendor) return;
      // Re-read once so the pushed rate limits and cached account identity are
      // painted atomically rather than briefly erasing the account row.
      await load();
    },
    [load, vendor],
  );
  return snapshot ?? (vendor ? { vendor, windows: [] } : null);
}

export function CukiiVendorUsageSection({
  brokerModel,
}: {
  brokerModel?: BrokerModel;
}) {
  const messenger = useContext(IdeMessengerContext);
  const vendor = useMemo(
    () => (brokerModel ? brokerVendorForModel(brokerModel) : undefined),
    [brokerModel],
  );
  const snapshot = useVendorUsage(vendor);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSED_KEY) === "1",
  );
  if (!vendor || !snapshot) return null;
  const expanded = !collapsed;
  return (
    <Section data-testid="cukii-vendor-usage" data-vendor={vendor}>
      <SectionHeader>
        <SectionToggle
          type="button"
          aria-expanded={expanded}
          title={`${expanded ? "Collapse" : "Expand"} account & usage`}
          onClick={() => {
            const next = !collapsed;
            setCollapsed(next);
            localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
          }}
        >
          <Chevron $expanded={expanded} />
          <SectionLabel>Account &amp; usage</SectionLabel>
        </SectionToggle>
        <SectionLink
          type="button"
          title="View account and usage details"
          onClick={() =>
            void messenger.request("cukii/openVendorUsageDetails", { vendor })
          }
        >
          View details
        </SectionLink>
      </SectionHeader>
      {expanded && <UsageContents snapshot={snapshot} />}
    </Section>
  );
}

export function CukiiVendorUsageDetails({
  vendor,
}: {
  vendor?: BrokerVendorId;
}) {
  const messenger = useContext(IdeMessengerContext);
  const snapshot = useVendorUsage(vendor);
  if (!vendor || !snapshot) return null;
  return (
    <DetailsRoot data-testid="cukii-vendor-usage-details" data-vendor={vendor}>
      <DetailsCard>
        <DetailsTitle>Account &amp; Usage</DetailsTitle>
        <DetailsClose
          type="button"
          aria-label="Close account and usage details"
          title="Close"
          onClick={() =>
            void messenger.request("cukii/closeVendorUsageDetails", undefined)
          }
        >
          <XMarkIcon />
        </DetailsClose>
        <DetailsVendor>{cukiiVendorLabel(vendor)}</DetailsVendor>
        <UsageContents snapshot={snapshot} />
      </DetailsCard>
    </DetailsRoot>
  );
}
