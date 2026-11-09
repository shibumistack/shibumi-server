import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import packageJson from "../package.json";

test("release version uses a preferred digit sum", () => {
  const sum = (packageJson.version.match(/\d/g) ?? []).reduce((total, digit) => total + Number(digit), 0);
  expect([1, 2, 3, 5, 7, 9]).toContain(sum);
});

test("publishes short and compatible CLI names", async () => {
  expect(packageJson.bin).toEqual({ shis: "bin/shis", "shibumi-server": "bin/shis" });
  expect(await readFile(resolve(import.meta.dir, "../bin/shis"), "utf8")).toContain('import "../src/cli.ts"');
});

test("published files use an explicit allowlist", () => {
  expect(packageJson.files).toEqual(expect.arrayContaining(["bin", "src", "docs", "examples", "install.sh", "README.md", "LICENSE", "runtime-lock.json"]));
  expect(packageJson.files).not.toContain("config.json");
  expect(packageJson.files).not.toContain(".env");
});

test("website, generated apps, and integration use the default Bun image", async () => {
  const from = "FROM oven/bun:alpine";
  expect(await readFile(resolve(import.meta.dir, "../Dockerfile"), "utf8")).toStartWith(`${from} AS build\n`);
  expect(await readFile(resolve(import.meta.dir, "integration/fixture/Containerfile"), "utf8")).toStartWith("FROM docker.io/oven/bun:alpine\n");
  expect(await readFile(resolve(import.meta.dir, "../scripts/ship.ts"), "utf8")).toContain(`Dockerfile: \`${from}\n`);
});

test("published runtime lock matches Bun lock", async () => {
  const root = resolve(import.meta.dir, "..");
  expect(await readFile(resolve(root, "runtime-lock.json"), "utf8"))
    .toBe(await readFile(resolve(root, "bun.lock"), "utf8"));
});
