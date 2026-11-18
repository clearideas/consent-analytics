// Checks that the release tag matches the version of the package being published.
//   RELEASE_TAG=v1.2.3 node scripts/check-release-tag.mjs                       (browser library)
//   RELEASE_TAG=server-v1.2.3 node scripts/check-release-tag.mjs server server-v
//   RELEASE_TAG=collector-v1.2.3 node scripts/check-release-tag.mjs collector collector-v
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [dir = ".", prefix = "v"] = process.argv.slice(2);
const manifestUrl = new URL(`../${dir}/package.json`, import.meta.url);
const { name, version } = JSON.parse(readFileSync(manifestUrl, "utf8"));
const tag = process.env.RELEASE_TAG;
assert(
  tag && tag === `${prefix}${version}`,
  `Release tag must exactly match ${prefix} + ${dir}/package.json version (${prefix}${version}); update package.json and package-lock.json before tagging.`,
);
console.log(`Release tag matches ${name} version ${version}.`);
