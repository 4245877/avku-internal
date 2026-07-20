import sharp from "sharp";

import type { PdfPageImage } from "./certificate-pdf";

/**
 * Prepares up to four certificates for duplex printing on a single A4 sheet.
 *
 * Geometry: the sheet is a fixed 2×2 grid of card slots. Cards fill the grid
 * row by row (slot 0 = top-left, 1 = top-right, 2 = bottom-left, 3 = bottom-
 * right). The slot geometry is identical on both sides of the sheet, so a card
 * on the front always has a matching slot directly behind it on the back.
 *
 * For duplex printing (flip on the long edge) the back side must be mirrored
 * horizontally: within each row the left and right cards swap columns. That way
 * the English back of a card lines up behind its front once the paper is
 * flipped.
 */

const RENDER_DPI = 300;
const MM_PER_INCH = 25.4;

function mmToPx(millimetres: number): number {
  return Math.round((millimetres / MM_PER_INCH) * RENDER_DPI);
}

/** A4 portrait at 300 DPI (210×297 mm → 2480×3508 px). */
export const A4_WIDTH_PX = mmToPx(210);
export const A4_HEIGHT_PX = mmToPx(297);

export const PRINT_SHEET_COLUMNS = 2;
export const PRINT_SHEET_ROWS = 2;
export const MAX_PRINT_SHEET_CARDS = PRINT_SHEET_COLUMNS * PRINT_SHEET_ROWS;

export interface SheetSlot {
  column: number;
  row: number;
}

export interface SlotPosition {
  left: number;
  top: number;
}

/**
 * Row-major slot for the card at `index` on the front side.
 */
export function getFrontSlot(index: number): SheetSlot {
  return {
    column: index % PRINT_SHEET_COLUMNS,
    row: Math.floor(index / PRINT_SHEET_COLUMNS),
  };
}

/**
 * Back-side slot for the same card: the column is mirrored within its row so
 * the card aligns behind its front after a long-edge duplex flip.
 */
export function getBackSlot(index: number): SheetSlot {
  const front = getFrontSlot(index);

  return {
    column: PRINT_SHEET_COLUMNS - 1 - front.column,
    row: front.row,
  };
}

/**
 * Top-left pixel position of a slot, centring the 2×2 block on the sheet with
 * equal outer margins and gutters (each = free space / 3).
 */
export function getSlotPosition(
  slot: SheetSlot,
  cardWidth: number,
  cardHeight: number,
): SlotPosition {
  const freeX = A4_WIDTH_PX - PRINT_SHEET_COLUMNS * cardWidth;
  const freeY = A4_HEIGHT_PX - PRINT_SHEET_ROWS * cardHeight;
  const gutterX = Math.round(freeX / (PRINT_SHEET_COLUMNS + 1));
  const gutterY = Math.round(freeY / (PRINT_SHEET_ROWS + 1));

  return {
    left: gutterX + slot.column * (cardWidth + gutterX),
    top: gutterY + slot.row * (cardHeight + gutterY),
  };
}

export interface SheetCardPlacement {
  pngPath: string;
  slot: SheetSlot;
}

/**
 * Composites the given card PNGs onto a white A4 canvas and returns the sheet
 * as a JPEG page image ready for the PDF builder. The card pixel size is taken
 * from the first card (all certificate templates share a canvas size).
 */
export async function composePrintSheet(
  placements: SheetCardPlacement[],
): Promise<PdfPageImage> {
  if (placements.length === 0) {
    throw new Error("Не вибрано жодного посвідчення для друку.");
  }

  const firstCard = await sharp(placements[0].pngPath).metadata();
  const cardWidth = firstCard.width ?? 0;
  const cardHeight = firstCard.height ?? 0;

  if (!cardWidth || !cardHeight) {
    throw new Error("Не вдалося визначити розмір посвідчення.");
  }

  const composites = placements.map((placement) => {
    const position = getSlotPosition(
      placement.slot,
      cardWidth,
      cardHeight,
    );

    return {
      input: placement.pngPath,
      left: position.left,
      top: position.top,
    };
  });

  const rendered = await sharp({
    create: {
      width: A4_WIDTH_PX,
      height: A4_HEIGHT_PX,
      channels: 3,
      background: {
        r: 255,
        g: 255,
        b: 255,
      },
    },
  })
    .composite(composites)
    .jpeg({
      quality: 96,
      mozjpeg: true,
    })
    .toBuffer({
      resolveWithObject: true,
    });

  return {
    data: rendered.data,
    width: rendered.info.width,
    height: rendered.info.height,
  };
}
