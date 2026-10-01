#!/usr/bin/env node
/**
 * Runs from the `version` npm lifecycle hook (`npm run release:patch|minor|major`), after
 * package.json has been bumped and before npm commits. It turns the `## [Unreleased]`
 * section of CHANGELOG.md into `## [x.y.z] - YYYY-MM-DD`, opens a fresh empty Unreleased
 * section, and rewrites the comparison links at the bottom.
 *
 * Pass `--check` to validate without writing (used by `npm run release:check`).
 */
import { readFileSync, writeFileSync } from "node:fs";

const check = process.argv.includes("--check");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;
const repo = pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
const today = new Date().toISOString().slice(0, 10);

const path = "CHANGELOG.md";
const original = readFileSync(path, "utf8");

const unreleasedHeading = "## [Unreleased]";
const start = original.indexOf(unreleasedHeading);
if (start === -1) fail(`CHANGELOG.md has no "${unreleasedHeading}" section.`);

const afterHeading = start + unreleasedHeading.length;
const nextHeading = original.indexOf("\n## [", afterHeading);
const linksStart = original.indexOf("\n[Unreleased]:", afterHeading);
const sectionEnd = nextHeading === -1 ? linksStart : nextHeading;
if (sectionEnd === -1) fail("CHANGELOG.md is missing the [Unreleased] link at the bottom.");

const body = original.slice(afterHeading, sectionEnd).trim();
if (!body) fail("The [Unreleased] section is empty. Add entries before releasing.");
// In --check mode package.json still holds the current (already released) version, so the
// collision test only makes sense after `npm version` has bumped it.
if (!check && original.includes(`## [${version}]`)) {
  fail(`CHANGELOG.md already has a section for ${version}.`);
}

const prevMatch = original.slice(sectionEnd).match(/^## \[(\d+\.\d+\.\d+[^\]]*)\]/m);
const prev = prevMatch ? prevMatch[1] : null;

const newSection = `${unreleasedHeading}\n\n## [${version}] - ${today}\n\n${body}\n`;
let out = original.slice(0, start) + newSection + original.slice(sectionEnd);

const unreleasedLink = `[Unreleased]: ${repo}/compare/v${version}...HEAD`;
const versionLink = prev
  ? `[${version}]: ${repo}/compare/v${prev}...v${version}`
  : `[${version}]: ${repo}/releases/tag/v${version}`;
out = out.replace(/^\[Unreleased\]: .*$/m, `${unreleasedLink}\n${versionLink}`);

if (check) {
  const lines = body.split("\n").length;
  console.log(`CHANGELOG.md: [Unreleased] has ${lines} lines, ready for the next release.`);
} else {
  writeFileSync(path, out);
  console.log(`CHANGELOG.md: released ${version} (${today}).`);
}

function fail(message) {
  console.error(`release-changelog: ${message}`);
  process.exit(1);
}
