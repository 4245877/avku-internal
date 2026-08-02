import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  houseVisibilitySql,
  resolveViewer,
} from "../modules/elections/elections-access";

/**
 * The LAN stand-in identity (`ELECTIONS_LOCAL_EMAIL`).
 *
 * The bug this covers cost a whole deployment: `infra/nginx/app.conf` strips
 * `Cf-Access-*` on every host but the tunnel's, so a request from the office
 * network reaches the API with no email — and a viewer with no email gets the
 * `0 = 1` visibility clause, i.e. an empty map over a fully populated database.
 * Nothing in the module said so; the map simply had no houses on it.
 *
 * These tests pin both halves: that the fallback grants exactly the role the
 * allowlist says and no more, and that it never displaces a real identity.
 */

const LOCAL = "shtab@avku.test";
const REAL = "someone@avku.test";

const SAVED = {
  local: process.env.ELECTIONS_LOCAL_EMAIL,
  admins: process.env.ELECTIONS_ADMIN_EMAILS,
  devAuth: process.env.ELECTIONS_DEV_AUTH,
  devRole: process.env.ELECTIONS_DEV_ROLE,
};

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

beforeEach(() => {
  delete process.env.ELECTIONS_LOCAL_EMAIL;
  delete process.env.ELECTIONS_ADMIN_EMAILS;
  delete process.env.ELECTIONS_DEV_AUTH;
  delete process.env.ELECTIONS_DEV_ROLE;
});

afterEach(() => {
  restore(
    "ELECTIONS_LOCAL_EMAIL",
    SAVED.local,
  );
  restore(
    "ELECTIONS_ADMIN_EMAILS",
    SAVED.admins,
  );
  restore(
    "ELECTIONS_DEV_AUTH",
    SAVED.devAuth,
  );
  restore(
    "ELECTIONS_DEV_ROLE",
    SAVED.devRole,
  );
});

describe("local network identity", () => {
  test("an unconfigured deployment still sees nobody", () => {
    const viewer = resolveViewer({
      email: null,
    });

    assert.equal(
      viewer.email,
      null,
    );
    assert.equal(
      viewer.role,
      null,
    );
    assert.equal(
      viewer.isLocalAuth,
      false,
    );
  });

  test("the local email earns its role through the admin allowlist", () => {
    process.env.ELECTIONS_LOCAL_EMAIL = LOCAL;
    process.env.ELECTIONS_ADMIN_EMAILS = LOCAL;

    const viewer = resolveViewer({
      email: null,
    });

    assert.equal(
      viewer.email,
      LOCAL,
    );
    assert.equal(
      viewer.role,
      "admin",
    );
    assert.equal(
      viewer.isLocalAuth,
      true,
    );
    assert.equal(
      viewer.isDevAuth,
      false,
      "a LAN identity is not the development override and must not report as one",
    );
  });

  test("a local email outside the allowlist gets no role at all", () => {
    process.env.ELECTIONS_LOCAL_EMAIL = LOCAL;
    process.env.ELECTIONS_ADMIN_EMAILS = "somebody-else@avku.test";

    const viewer = resolveViewer({
      email: null,
    });

    assert.equal(
      viewer.email,
      LOCAL,
    );
    assert.equal(
      viewer.role,
      null,
      "naming the LAN identity must not by itself grant rights",
    );
  });

  test("a stored role applies to the local identity", () => {
    process.env.ELECTIONS_LOCAL_EMAIL = LOCAL;

    const viewer = resolveViewer({
      email: null,
      storedRole: "coordinator",
    });

    assert.equal(
      viewer.role,
      "coordinator",
    );
    assert.equal(
      viewer.isLocalAuth,
      true,
    );
  });

  test("a real Access identity is never displaced by the local one", () => {
    process.env.ELECTIONS_LOCAL_EMAIL = LOCAL;
    process.env.ELECTIONS_ADMIN_EMAILS = LOCAL;

    const viewer = resolveViewer({
      email: REAL,
      storedRole: "agitator",
    });

    assert.equal(
      viewer.email,
      REAL,
      "the signed-in user must keep their own identity",
    );
    assert.equal(
      viewer.role,
      "agitator",
      "the LAN allowlist must not lift a signed-in user to admin",
    );
    assert.equal(
      viewer.isLocalAuth,
      false,
    );
  });

  test("the local identity survives NODE_ENV=production", () => {
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.ELECTIONS_LOCAL_EMAIL = LOCAL;
    process.env.ELECTIONS_ADMIN_EMAILS = LOCAL;

    try {
      const viewer = resolveViewer({
        email: null,
      });

      assert.equal(
        viewer.role,
        "admin",
        "a LAN appliance is a production deployment; unlike dev auth this must keep working",
      );
    } finally {
      restore(
        "NODE_ENV",
        savedEnv,
      );
    }
  });

  test("the granted role actually opens up house visibility", () => {
    process.env.ELECTIONS_LOCAL_EMAIL = LOCAL;
    process.env.ELECTIONS_ADMIN_EMAILS = LOCAL;

    const anonymous = houseVisibilitySql(
      resolveViewer({
        email: null,
      }),
      "campaign-1",
      "h",
    );

    assert.notEqual(
      anonymous.sql.replace(
        /\s/g,
        "",
      ),
      "0=1",
      "this is the clause that emptied the map: the configured LAN viewer must clear it",
    );
  });

  test("without the variable the visibility clause still blocks everything", () => {
    const blocked = houseVisibilitySql(
      resolveViewer({
        email: null,
      }),
      "campaign-1",
      "h",
    );

    assert.equal(
      blocked.sql.replace(
        /\s/g,
        "",
      ),
      "0=1",
    );
  });
});
