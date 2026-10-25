import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkVersionFloor } from "./version-floor.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
/** A Compose variable reference, spelled so it is not a template placeholder. */
const PS_IMAGE = "$" + "{PS_IMAGE}";
const OTHER = `sha256:${"b".repeat(64)}`;
const lines = (compose: string) => checkVersionFloor("c.yml", compose).map((f) => `${f.status}: ${f.detail}`);

describe("checkVersionFloor", () => {
  it("passes Fieldbook's compose file", () => {
    const compose = readFileSync(new URL("../../../../examples/fieldbook/docker-compose.yml", import.meta.url), "utf8");
    expect(checkVersionFloor("docker-compose.yml", compose)).toEqual([
      { status: "ok", check: "version floor", detail: "docker-compose.yml: service powersync pins PowerSync 1.27.2 by digest" },
    ]);
  });

  it("reads a version from the tag, or from a marker on the service beside a digest", () => {
    expect(lines("services:\n  ps:\n    image: journeyapps/powersync-service:1.20.1")).toEqual([
      "warn: c.yml: service ps pins PowerSync 1.20.1; a tag can move, so pin the digest too",
    ]);
    expect(lines(`services:\n  # powersync-service-version: 1.21.0\n  ps:\n    image: journeyapps/powersync-service@${DIGEST}`)).toEqual([
      "ok: c.yml: service ps pins PowerSync 1.21.0 by digest",
    ]);
    expect(lines(`services:\n  ps:\n    # powersync-service-version: 1.21.0\n    image: journeyapps/powersync-service@${DIGEST}`)[0]).toMatch(/^ok/);
    expect(lines(`services:\n  ps:\n    image: journeyapps/powersync-service@${DIGEST} # powersync-service-version: 1.21.0`)[0]).toMatch(/^ok/);
    expect(lines(`services:\n  ps:\n    image: journeyapps/powersync-service:1.21.0@${DIGEST}`)[0]).toMatch(/^ok/);
  });

  it("fails below the floor, without a version, or with conflicting labels", () => {
    expect(lines("services:\n  ps:\n    image: journeyapps/powersync-service:1.20.0")).toEqual([
      "fail: c.yml: service ps pins PowerSync 1.20.0, below the 1.20.1 floor: older services ignore the auth.parameter() role gates",
    ]);
    expect(lines(`services:\n  # powersync-service-version: 1.9.9\n  ps:\n    image: journeyapps/powersync-service@${DIGEST}`)[0]).toMatch(/1.9.9, below/);
    expect(lines("services:\n  ps:\n    image: journeyapps/powersync-service:latest")[0]).toMatch(/^fail: .*names no version/);
    expect(lines(`services:\n  ps:\n    image: journeyapps/powersync-service@${DIGEST}`)[0]).toMatch(/^fail: .*names no version/);
    expect(lines(`services:\n  # powersync-service-version: 1.30.0\n  ps:\n    image: journeyapps/powersync-service:1.21.0@${DIGEST}`)[0]).toMatch(
      /more than one version/,
    );
  });

  it("binds a marker to its own service, and checks every PowerSync service", () => {
    const two = `services:\n  # powersync-service-version: 1.27.2\n  a:\n    image: journeyapps/powersync-service@${DIGEST}\n  b:\n    image: journeyapps/powersync-service@${OTHER}`;
    expect(lines(two)).toEqual([
      "ok: c.yml: service a pins PowerSync 1.27.2 by digest",
      `fail: c.yml: service b (journeyapps/powersync-service@${OTHER}) names no version; pin a release tag, or a digest with a "# powersync-service-version: x.y.z" comment on the service`,
    ]);
    // A marker in an unrelated comment vouches for nothing.
    expect(lines(`# powersync-service-version: 1.27.2\nservices:\n  ps:\n    image: journeyapps/powersync-service@${DIGEST}`)[0]).toMatch(/^fail: .*names no version/);
  });

  it("ignores commented-out images and refuses images it cannot identify", () => {
    expect(lines(`services:\n  ps:\n    # image: journeyapps/powersync-service:1.27.2\n    image: ${PS_IMAGE}`)).toEqual([
      `warn: c.yml: service ps runs ${PS_IMAGE}, which cannot be read here`,
      "fail: c.yml runs no journeyapps/powersync-service image",
    ]);
    expect(lines("services:\n  ps:\n    image: myorg/powersync-service:1.27.2")).toEqual([
      "fail: c.yml: service ps runs myorg/powersync-service:1.27.2, not journeyapps/powersync-service, so its version cannot be checked",
    ]);
    expect(lines("services:\n  db:\n    image: postgres:18")).toEqual(["fail: c.yml runs no journeyapps/powersync-service image"]);
    expect(lines("services: [")[0]).toMatch(/^fail: c.yml is not valid YAML/);
  });

  it("does not let a decoy service vouch for one it cannot read", () => {
    const decoy = `  decoy:\n    # powersync-service-version: 1.27.2\n    image: journeyapps/powersync-service@${DIGEST}\n    profiles: [never]\n`;
    expect(lines(`x-img: &img journeyapps/powersync-service:1.19.0\nservices:\n${decoy}  powersync:\n    image: *img\n`)).toEqual([
      "ok: c.yml: service decoy pins PowerSync 1.27.2 by digest",
      "fail: c.yml: service powersync pins PowerSync 1.19.0, below the 1.20.1 floor: older services ignore the auth.parameter() role gates",
    ]);
    expect(lines(`x-ps: &ps\n  image: journeyapps/powersync-service:1.19.0\nservices:\n${decoy}  powersync:\n    <<: *ps\n`)[1]).toMatch(/1.19.0, below/);
    expect(lines(`services:\n${decoy}  powersync:\n    build: ./old\n`)[1]).toBe(
      "fail: c.yml: service powersync is built locally, not journeyapps/powersync-service, so its version cannot be checked",
    );
    expect(lines(`services:\n${decoy}  powersync:\n    image: ${PS_IMAGE}\n`)[1]).toBe(
      `fail: c.yml: service powersync runs ${PS_IMAGE}, not journeyapps/powersync-service, so its version cannot be checked`,
    );
  });
});
