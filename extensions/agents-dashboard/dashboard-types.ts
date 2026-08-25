import type { SessionRecord } from "../../shared/contracts.js";
import type { DashboardGroup, DashboardSortKey } from "./dashboard-state.js";

export type SortKey = DashboardSortKey;
export type DashboardDensity = "full" | "compact" | "minimal";

export interface DashboardColumn {
  key: SortKey;
  width: number;
}

export interface DashboardLayout {
  width: number;
  height: number;
  density: DashboardDensity;
  listTop: number;
  listHeight: number;
  columns: readonly DashboardColumn[];
}

export type VirtualRow =
  | {
      kind: "group";
      key: string;
      label: string;
      count: number;
      selectable: false;
    }
  | {
      kind: "session";
      key: string;
      session: SessionRecord;
      selectable: true;
    };

export interface VirtualViewport {
  offset: number;
  height: number;
  width: number;
}

export interface RenderedVirtualRow {
  index: number;
  row: VirtualRow;
  line: string;
}

export type VirtualRowRenderer = (
  row: VirtualRow,
  width: number,
  selected: boolean,
) => string;

export interface VirtualSessionListOptions {
  groupBy?: DashboardGroup;
  now?: number;
  renderRow?: VirtualRowRenderer;
}
