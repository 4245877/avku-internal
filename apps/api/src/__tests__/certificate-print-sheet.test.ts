import { test } from "node:test";
import assert from "node:assert/strict";

import {
  A4_HEIGHT_PX,
  A4_WIDTH_PX,
  getBackSlot,
  getFrontSlot,
  getSlotPosition,
  MAX_PRINT_SHEET_CARDS,
} from "../modules/certificates/certificate-print-sheet";

const CARD_WIDTH = 1004;
const CARD_HEIGHT = 1358;

test("A4 sheet is 210×297 mm at 300 DPI", () => {
  assert.equal(A4_WIDTH_PX, 2480);
  assert.equal(A4_HEIGHT_PX, 3508);
  assert.equal(MAX_PRINT_SHEET_CARDS, 4);
});

test("front slots fill the 2×2 grid row by row", () => {
  assert.deepEqual(getFrontSlot(0), { column: 0, row: 0 });
  assert.deepEqual(getFrontSlot(1), { column: 1, row: 0 });
  assert.deepEqual(getFrontSlot(2), { column: 0, row: 1 });
  assert.deepEqual(getFrontSlot(3), { column: 1, row: 1 });
});

test("back slots mirror the column within the same row", () => {
  for (let index = 0; index < MAX_PRINT_SHEET_CARDS; index += 1) {
    const front = getFrontSlot(index);
    const back = getBackSlot(index);

    assert.equal(back.row, front.row, "row must be preserved");
    assert.equal(back.column, 1 - front.column, "column must be mirrored");
  }
});

test("a card and its mirrored back are horizontally symmetric on the sheet", () => {
  for (let index = 0; index < MAX_PRINT_SHEET_CARDS; index += 1) {
    const front = getSlotPosition(getFrontSlot(index), CARD_WIDTH, CARD_HEIGHT);
    const back = getSlotPosition(getBackSlot(index), CARD_WIDTH, CARD_HEIGHT);

    // Same vertical position — the flip is on the long (vertical) edge only.
    assert.equal(front.top, back.top);

    // The gap to the left edge on the front equals the gap to the right edge on
    // the back (within integer-rounding tolerance), i.e. the two align once the
    // sheet is flipped for duplex printing.
    const frontLeftGap = front.left;
    const backRightGap = A4_WIDTH_PX - (back.left + CARD_WIDTH);

    assert.ok(
      Math.abs(frontLeftGap - backRightGap) <= 2,
      `index ${index}: expected symmetric gaps, got ${frontLeftGap} vs ${backRightGap}`,
    );
  }
});

test("cards stay within the A4 bounds", () => {
  for (let index = 0; index < MAX_PRINT_SHEET_CARDS; index += 1) {
    const position = getSlotPosition(getFrontSlot(index), CARD_WIDTH, CARD_HEIGHT);

    assert.ok(position.left >= 0);
    assert.ok(position.top >= 0);
    assert.ok(position.left + CARD_WIDTH <= A4_WIDTH_PX);
    assert.ok(position.top + CARD_HEIGHT <= A4_HEIGHT_PX);
  }
});
