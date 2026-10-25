/**
 * The PowerSync service version is a security floor. Before 1.20.1 the service did not
 * enforce auth.parameter() filters in sync streams, so every role gate in the generated
 * config was decorative: more rows reached more devices, and nothing looked wrong.
 *
 * The service reports no version over HTTP, so the pin is read from the project's
 * compose file, service by service: the image tag, or a
 * `# powersync-service-version: x.y.z` comment on that service (above its name or its
 * image line) when the image is pinned by digest. Comments elsewhere count for nothing.
 * Any service whose name or image mentions powersync is checked, and one whose image
 * cannot be read as a literal journeyapps reference (a variable, a build, an unresolved
 * alias) fails: a decoy service must not vouch for the one that runs.
 */

import { isMap, isScalar, parseDocument } from "yaml";
import type { Finding } from "../report.ts";

/** The release where the stream auth filter fix landed. Do not lower. */
export const VERSION_FLOOR = [1, 20, 1] as const;

const REPOSITORY = /^(?:docker\.io\/)?journeyapps\/powersync-service(?::([\w.-]+))?(?:@(sha256:[a-f0-9]{64}))?$/;
const MARKER = /powersync-service-version:\s*(\d+\.\d+\.\d+)\b/g;

export function checkVersionFloor(file: string, compose: string): Finding[] {
  const check = "version floor";
  const fail = (detail: string): Finding => ({ status: "fail", check, detail });
  const doc = parseDocument(compose, { merge: true });
  if (doc.errors.length) return [fail(`${file} is not valid YAML: ${doc.errors[0]?.message}`)];
  const services = doc.get("services");
  if (!isMap(services)) return [fail(`${file} has no services`)];

  // Aliases and merge keys resolved, as Compose resolves them.
  const resolved = (doc.toJS({ maxAliasCount: 100 }) as { services?: Record<string, { image?: unknown; build?: unknown } | null> }).services ?? {};
  const out: Finding[] = [];
  let checked = 0;
  for (const [index, pair] of services.items.entries()) {
    const name = isScalar(pair.key) ? String(pair.key.value) : "?";
    const service = resolved[name];
    const image = typeof service?.image === "string" ? service.image : undefined;
    const unreadable = !image || image.includes("${");
    if (!/powersync/i.test(image ?? "") && !(/powersync/i.test(name) && unreadable)) {
      // A variable could name any image, PowerSync included.
      if (image?.includes("${")) out.push({ status: "warn", check, detail: `${file}: service ${name} runs ${image}, which cannot be read here` });
      continue;
    }
    checked++;
    const m = image ? REPOSITORY.exec(image) : null;
    if (!m) {
      const what = image ? `runs ${image}` : service?.build !== undefined ? "is built locally" : "names no literal image";
      out.push(fail(`${file}: service ${name} ${what}, not journeyapps/powersync-service, so its version cannot be checked`));
      continue;
    }
    if (!isMap(pair.value)) continue;
    const imagePair = pair.value.items.find((p) => isScalar(p.key) && p.key.value === "image");
    const [, tag, digest] = m;
    const comments = [
      // The yaml parser hangs a comment above a map's first key on the map itself.
      index === 0 ? services.commentBefore : undefined,
      isScalar(pair.key) ? pair.key.commentBefore : undefined,
      pair.value.items[0] === imagePair ? pair.value.commentBefore : undefined,
      imagePair && isScalar(imagePair.key) ? imagePair.key.commentBefore : undefined,
      imagePair && isScalar(imagePair.value) ? imagePair.value.comment : undefined,
    ].join("\n");
    const markers = [...comments.matchAll(MARKER)].map((x) => x[1] as string);
    const tagged = tag && /^\d+\.\d+\.\d+$/.test(tag) ? tag : undefined;
    // A digest pins bytes, not a version: the marker says which release those bytes are.
    const versions = [...new Set([tagged, ...(digest ? markers : [])].filter((v): v is string => v !== undefined))];
    if (versions.length === 0) {
      out.push(fail(`${file}: service ${name} (${image}) names no version; pin a release tag, or a digest with a "# powersync-service-version: x.y.z" comment on the service`));
    } else if (versions.length > 1) {
      out.push(fail(`${file}: service ${name} is labelled with more than one version (${versions.join(", ")})`));
    } else if (compare(versions[0] as string) < 0) {
      out.push(fail(`${file}: service ${name} pins PowerSync ${versions[0]}, below the ${VERSION_FLOOR.join(".")} floor: older services ignore the auth.parameter() role gates`));
    } else {
      out.push({
        status: digest ? "ok" : "warn",
        check,
        detail: `${file}: service ${name} pins PowerSync ${versions[0]}${digest ? " by digest" : "; a tag can move, so pin the digest too"}`,
      });
    }
  }
  if (checked === 0) out.push(fail(`${file} runs no journeyapps/powersync-service image`));
  return out;
}

function compare(version: string): number {
  const parts = version.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (parts[i] ?? 0) - VERSION_FLOOR[i];
    if (d !== 0) return d;
  }
  return 0;
}
