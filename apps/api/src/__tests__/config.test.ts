import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { createWarehouseRepository } from "../config";

const ORIGINAL_ENV = {
  DATA_ROOT: process.env.DATA_ROOT,
  NODE_ENV: process.env.NODE_ENV,
};

afterEach(() => {
  if (ORIGINAL_ENV.DATA_ROOT === undefined) {
    delete process.env.DATA_ROOT;
  } else {
    process.env.DATA_ROOT = ORIGINAL_ENV.DATA_ROOT;
  }

  if (ORIGINAL_ENV.NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV;
  }
});

test("production requires DATA_ROOT instead of falling back to repo storage", () => {
  process.env.NODE_ENV = "production";
  delete process.env.DATA_ROOT;

  assert.throws(
    () => createWarehouseRepository(),
    /DATA_ROOT must be set when NODE_ENV=production/,
  );
});
