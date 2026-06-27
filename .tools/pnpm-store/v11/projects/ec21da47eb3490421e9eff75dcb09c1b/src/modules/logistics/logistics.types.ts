export type TransferStatus =
  | "planned"
  | "transferred"
  | "report";

export type DocumentState =
  | "missing"
  | "pending"
  | "ready";

export type LogisticsEventType =
  | "created"
  | "status"
  | "act"
  | "photo"
  | "note";

export interface ManifestLine {
  name: string;
  quantity: string;
}

export interface LogisticsEvent {
  id: string;
  transferId: string;
  type: LogisticsEventType;
  date: string;
  title: string;
  meta: string;
  createdAt: string;
}

export interface Transfer {
  id: string;
  code: string;
  route: string;
  recipient: string;
  driver: string;
  transferDate: string;
  status: TransferStatus;
  routeConfirmed: boolean;
  actState: DocumentState;
  actReference: string;
  photoState: DocumentState;
  photoCount: number;
  requestId: string;
  warehouseId: string;
  reportId: string;
  notes: string;
  manifest: ManifestLine[];
  createdAt: string;
  updatedAt: string;
}

export interface TransferResponse extends Transfer {
  events: LogisticsEvent[];
}

export interface TransferPayload {
  route?: unknown;
  recipient?: unknown;
  driver?: unknown;
  transferDate?: unknown;
  status?: unknown;
  routeConfirmed?: unknown;
  actState?: unknown;
  actReference?: unknown;
  photoState?: unknown;
  photoCount?: unknown;
  requestId?: unknown;
  warehouseId?: unknown;
  reportId?: unknown;
  notes?: unknown;
  manifest?: unknown;
}

export interface TransferEventPayload {
  type?: unknown;
  status?: unknown;
  actState?: unknown;
  actReference?: unknown;
  photoState?: unknown;
  photoCount?: unknown;
  title?: unknown;
  meta?: unknown;
  date?: unknown;
}
