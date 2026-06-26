export type WarehouseMovementType =
  | "receipt"
  | "issue"
  | "reserve"
  | "note";

export interface WarehouseMovement {
  id: string;
  itemId: string;
  type: WarehouseMovementType;
  date: string;
  title: string;
  meta: string;
  createdAt: string;
}

export interface WarehouseItem {
  id: string;
  code: string;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  availableNow: number;
  condition: string;
  location: string;
  reservedFor: string;
  needsCheck: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WarehouseItemResponse extends WarehouseItem {
  movement: WarehouseMovement[];
}

export interface WarehouseItemPayload {
  name?: unknown;
  category?: unknown;
  quantity?: unknown;
  unit?: unknown;
  availableNow?: unknown;
  condition?: unknown;
  location?: unknown;
  reservedFor?: unknown;
  needsCheck?: unknown;
}

export interface WarehouseMovementPayload {
  type?: unknown;
  amount?: unknown;
  reservedFor?: unknown;
  title?: unknown;
  meta?: unknown;
  date?: unknown;
}
