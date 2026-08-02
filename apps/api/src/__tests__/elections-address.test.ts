import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  findMultipleHouseNumbers,
  normalizeAddress,
  normalizeHouseNumber,
  normalizeStreet,
} from "../modules/elections/elections.types";
import { splitAddress } from "../modules/elections/import-records";

/**
 * Address normalisation, against the shapes the 2020 archive actually contains.
 *
 * The second audit's §3.3 is the specification here: "разные языки, сокращения
 * и порядок частей адреса… В одной ячейке могут быть перечислены несколько
 * домов". Before these tests the key was a plain lowercase of whatever the
 * source wrote, so `вул. Зодчих` and `вулиця Зодчих` — the abbreviation used by
 * every spreadsheet and the full form stored by the OSM snapshot — were two
 * different buildings, and duplicate detection by address never fired once.
 */

/** What the OSM snapshot writes for вул. Зодчих, 58-А. */
const OSM_KEY = normalizeAddress(
  "вулиця Зодчих",
  "58-А",
);

describe("address normalisation", () => {
  test("every spelling of one address produces one key", () => {
    const variants = [
      [
        "вул. Зодчих",
        "58-А",
      ],
      [
        "вулиця Зодчих",
        "58-А",
      ],
      [
        "ул. Зодчих",
        "58/А",
      ],
      [
        "улица Зодчих",
        "58 А",
      ],
      [
        "Зодчих",
        "58а",
      ],
      // Latin `A` typed where Cyrillic `А` was meant.
      [
        "вул. Зодчих",
        "58-A",
      ],
      [
        "вул. Зодчих",
        "буд. 58-А",
      ],
    ];

    for (const [street, number] of variants) {
      assert.equal(
        normalizeAddress(
          street,
          number,
        ),
        OSM_KEY,
        `${street} / ${number} must match the snapshot's key`,
      );
    }
  });

  test("a settlement prefix is not part of the street", () => {
    assert.equal(
      normalizeStreet("м. Київ, вул. Зодчих"),
      "зодчих",
    );
    assert.equal(
      normalizeStreet("г. Киев, ул. Зодчих"),
      "зодчих",
    );
  });

  test("the corpus is folded into the number instead of being lost", () => {
    assert.equal(
      normalizeHouseNumber("12 корп. 2"),
      normalizeHouseNumber("12к2"),
    );
    // …and a corpus still distinguishes two different buildings.
    assert.notEqual(
      normalizeHouseNumber("12 корп. 2"),
      normalizeHouseNumber("12 корп. 3"),
    );
  });

  test("different houses keep different keys", () => {
    assert.notEqual(
      normalizeAddress(
        "вул. Зодчих",
        "58",
      ),
      normalizeAddress(
        "вул. Зодчих",
        "58-А",
      ),
    );
    assert.notEqual(
      normalizeAddress(
        "вул. Зодчих",
        "58",
      ),
      normalizeAddress(
        "вул. Пулюя",
        "58",
      ),
    );
  });
});

describe("splitting an address string", () => {
  test("a Cyrillic letter suffix is part of the number, not the street", () => {
    // `\w` without the `u` flag does not match Cyrillic, so this used to parse
    // as a street called "Зодчих 58а" with no house number at all.
    assert.deepEqual(
      splitAddress("Зодчих 58а"),
      {
        street: "Зодчих",
        number: "58а",
      },
    );
  });

  test("a leading settlement does not end up inside the street", () => {
    assert.deepEqual(
      splitAddress("м. Київ, вул. Зодчих, буд. 58-А"),
      {
        street: "вул. Зодчих",
        number: "58-А",
      },
    );
  });

  test("the plain comma form still works", () => {
    assert.deepEqual(
      splitAddress("вул. Зодчих, 58-А"),
      {
        street: "вул. Зодчих",
        number: "58-А",
      },
    );
  });

  test("a string with no number at all yields no number", () => {
    assert.deepEqual(
      splitAddress("вулиця Зодчих"),
      {
        street: "вулиця Зодчих",
        number: "",
      },
    );
  });
});

describe("several houses in one cell", () => {
  test("a list of numbers is reported rather than guessed at", () => {
    assert.deepEqual(
      findMultipleHouseNumbers("58, 60, 62"),
      [
        "58",
        "60",
        "62",
      ],
    );
    assert.deepEqual(
      findMultipleHouseNumbers("58 і 60"),
      [
        "58",
        "60",
      ],
    );
    assert.deepEqual(
      findMultipleHouseNumbers("58-А; 60-Б"),
      [
        "58-А",
        "60-Б",
      ],
    );
  });

  test("one house is not a list", () => {
    assert.deepEqual(
      findMultipleHouseNumbers("58-А"),
      [],
    );
    assert.deepEqual(
      findMultipleHouseNumbers("12 корп. 2"),
      [],
    );
    assert.deepEqual(
      findMultipleHouseNumbers(""),
      [],
    );
  });
});
