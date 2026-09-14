import { readFile, statfs } from "node:fs/promises";
import { freemem, homedir } from "node:os";
import { join } from "node:path";
import { appEnvPath, readAppEnv } from "./app-env";
import { APP_RETRY_BUDGET_MS } from "./caddy";
import { composePath, type AppConfig } from "./config";
import { inspectPrebuiltImageMetadata, runtimeImage, uploadedImage } from "./prebuilt";

const MEBIBYTE = 1024 * 1024;
export const ROLLBACK_RETENTION_MS = 12 * 60 * 60 * 1_000;

export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  capture?: boolean;
  timeoutMs?: number;
  stdin?: "ignore" | "inherit";
  input?: string;
  onOutput?(line: string): void | Promise<void>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult>;
}

export interface DeploymentLogger {
  info(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ResourceAvailability {
  memoryBytes: number;
  diskBytes: number;
}

export interface ResourceInspector {
  available(checkout: string): Promise<ResourceAvailability>;
}

export interface DeployDependencies {
  runner: CommandRunner;
  resources: ResourceInspector;
  fetch: Fetcher;
  sleep(milliseconds: number): Promise<void>;
  logger: DeploymentLogger;
  onStage?(stage: string): void | Promise<void>;
  onOutput?(stage: string, line: string): void | Promise<void>;
}

export class DeploymentError extends Error {
  constructor(
    readonly stage: string,
    message: string,
  ) {
    super(message);
    this.name = "DeploymentError";
  }
}

export function retryBudgetSummary(action: string, readinessMs: number, budgetMs = APP_RETRY_BUDGET_MS): string {
  if (!action || !Number.isInteger(readinessMs) || readinessMs < 0 || !Number.isInteger(budgetMs) || budgetMs < 1) {
    throw new Error("invalid retry budget measurement");
  }
  const difference = Math.abs(budgetMs - readinessMs);
  return `${action} in ${readinessMs}ms; Caddy retry budget ${budgetMs}ms; ${readinessMs <= budgetMs ? `headroom ${difference}ms` : `exceeded by ${difference}ms`}`;
}

function cleanEnvironment(extra: Record<string, string>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...extra };
}

export class BunCommandRunner implements CommandRunner {
  async run(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
    const capture = options.capture ?? false;
    const pipe = capture || options.onOutput !== undefined;
    let timedOut = false;
    const subprocess = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: cleanEnvironment(options.env ?? {}),
      stdin: options.input === undefined ? options.stdin ?? "ignore" : "pipe",
      stdout: pipe ? "pipe" : "inherit",
      stderr: pipe ? "pipe" : "inherit",
      detached: process.platform !== "win32",
    });
    if (options.input !== undefined) {
      subprocess.stdin!.write(options.input);
      subprocess.stdin!.end();
    }
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          try {
            if (process.platform === "win32") subprocess.kill("SIGKILL");
            else process.kill(-subprocess.pid, "SIGKILL");
          } catch {
            subprocess.kill("SIGKILL");
          }
        }, options.timeoutMs);

    const consume = async (stream: ReadableStream<Uint8Array>, target: NodeJS.WriteStream): Promise<string> => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let value = "";
      let pending = "";
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        const text = decoder.decode(chunk, { stream: true });
        if (capture) value += text;
        else target.write(text);
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) await options.onOutput?.(line);
      }
      pending += decoder.decode();
      if (pending.trim()) await options.onOutput?.(pending);
      return value;
    };

    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        subprocess.exited,
        pipe ? consume(subprocess.stdout!, process.stdout) : Promise.resolve(""),
        pipe ? consume(subprocess.stderr!, process.stderr) : Promise.resolve(""),
      ]);
      return { exitCode, stdout, stderr, timedOut };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export class HostResourceInspector implements ResourceInspector {
  async available(checkout: string): Promise<ResourceAvailability> {
    const [memoryBytes, filesystem] = await Promise.all([
      availableMemoryBytes(),
      statfs(checkout),
    ]);
    return {
      memoryBytes,
      diskBytes: filesystem.bavail * filesystem.bsize,
    };
  }
}

async function availableMemoryBytes(): Promise<number> {
  if (process.platform === "linux") {
    const memoryInfo = await readFile("/proc/meminfo", "utf8");
    const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(memoryInfo);
    if (!available) throw new Error("cannot determine available memory from /proc/meminfo");
    return Number(available[1]) * 1024;
  }
  return freemem();
}

async function runChecked(
  dependencies: DeployDependencies,
  stage: string,
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  await dependencies.onStage?.(stage);
  dependencies.logger.info("deployment stage started", { stage });
  const stream = (stage === "build" || stage === "test") && dependencies.onOutput
    ? { ...options, onOutput: (line: string) => dependencies.onOutput?.(stage, line) }
    : options;
  const result = await dependencies.runner.run(command, args, stream);
  if (result.timedOut) {
    throw new DeploymentError(stage, `${stage} timed out after ${options.timeoutMs}ms`);
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    throw new DeploymentError(stage, detail ? `${stage} failed: ${detail}` : `${stage} failed with exit code ${result.exitCode}`);
  }
  return result;
}

async function checkResources(app: AppConfig, dependencies: DeployDependencies): Promise<void> {
  let available: ResourceAvailability;
  try {
    available = await dependencies.resources.available(app.checkout);
  } catch (error) {
    throw new DeploymentError(
      "preflight",
      `resource preflight failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const memoryMb = Math.floor(available.memoryBytes / MEBIBYTE);
  if (memoryMb < app.minimumFreeMemoryMb) {
    throw new DeploymentError(
      "preflight",
      `resource preflight failed: ${memoryMb} MiB memory available; ${app.minimumFreeMemoryMb} MiB required`,
    );
  }
  const diskMb = Math.floor(available.diskBytes / MEBIBYTE);
  if (diskMb < app.minimumFreeDiskMb) {
    throw new DeploymentError(
      "preflight",
      `resource preflight failed: ${diskMb} MiB disk available; ${app.minimumFreeDiskMb} MiB required`,
    );
  }
}

async function waitForHealth(app: AppConfig, dependencies: DeployDependencies): Promise<void> {
  for (let attempt = 1; attempt <= app.healthAttempts; attempt += 1) {
    try {
      const response = await dependencies.fetch(app.healthUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(app.healthIntervalMs * 2, 5_000)),
      });
      if (response.ok) return;
    } catch {
      // The app may still be starting. Retry until the configured deadline.
    }
    if (attempt < app.healthAttempts) await dependencies.sleep(app.healthIntervalMs);
  }
  throw new DeploymentError("health", `health check did not pass after ${app.healthAttempts} attempts`);
}

async function expireRollbackImage(
  image: string,
  dependencies: DeployDependencies,
): Promise<void> {
  try {
    const exists = await dependencies.runner.run("podman", ["image", "exists", image], { capture: true });
    if (exists.exitCode !== 0) return;
    const removed = await dependencies.runner.run("podman", ["image", "rm", image], { capture: true });
    if (removed.exitCode !== 0) throw new Error(removed.stderr.trim() || `podman exited with code ${removed.exitCode}`);
    await dependencies.runner.run("podman", ["image", "prune", "--force"], { capture: true, timeoutMs: 60_000 });
  } catch (error) {
    const details = { image, error: error instanceof Error ? error.message : String(error) };
    if (dependencies.logger.warn) dependencies.logger.warn("rollback image expiry warning", details);
    else dependencies.logger.error("rollback image expiry warning", details);
  }
}

function armRollbackExpiry(image: string, expiresAt: number, dependencies: DeployDependencies): void {
  const timer = setTimeout(() => void expireRollbackImage(image, dependencies), Math.max(0, expiresAt - Date.now()));
  timer.unref();
}

export async function scheduleRollbackImageExpiry(
  appId: string,
  dependencies: DeployDependencies,
  now = Date.now(),
): Promise<void> {
  const repository = `localhost/shibumi-server/${appId}`;
  try {
    const listed = await dependencies.runner.run("podman", [
      "image", "list", "--filter", `reference=${repository}:rollback-*`, "--format", "{{.Tag}}",
    ], { capture: true });
    if (listed.exitCode !== 0) throw new Error(listed.stderr.trim() || `podman exited with code ${listed.exitCode}`);
    for (const tag of listed.stdout.split(/\r?\n/).filter((value) => /^rollback-\d{13}-[a-f0-9]{12}$/.test(value))) {
      const image = `${repository}:${tag}`;
      const expiresAt = Number(tag.split("-")[1]) + ROLLBACK_RETENTION_MS;
      if (expiresAt <= now) await expireRollbackImage(image, dependencies);
      else armRollbackExpiry(image, expiresAt, dependencies);
    }
  } catch (error) {
    const details = { app: appId, error: error instanceof Error ? error.message : String(error) };
    if (dependencies.logger.warn) dependencies.logger.warn("rollback image expiry warning", details);
    else dependencies.logger.error("rollback image expiry warning", details);
  }
}

export interface DeployMetadata {
  commit: string;
  deployedAt: string;
}

interface RunningRelease {
  imageId: string;
  imageName: string;
  metadata?: DeployMetadata;
}

async function retainRollbackImage(
  appId: string,
  app: AppConfig,
  previous: RunningRelease | undefined,
  commit: string,
  retentionTimestamp: number,
  removeCurrentUpload: boolean,
  dependencies: DeployDependencies,
): Promise<void> {
  const repository = `localhost/shibumi-server/${appId}`;
  const uploadRepository = `localhost/shibumi-server/upload/${appId}`;
  const warn = (action: string, error: unknown) => {
    const details = { app: appId, action, error: error instanceof Error ? error.message : String(error) };
    if (dependencies.logger.warn) dependencies.logger.warn("image retention warning", details);
    else dependencies.logger.error("image retention warning", details);
  };
  const bestEffort = async (action: string, args: string[], timeoutMs?: number): Promise<CommandResult | undefined> => {
    try {
      const result = await dependencies.runner.run("podman", args, { capture: true, timeoutMs });
      if (result.exitCode !== 0) {
        warn(action, result.stderr.trim() || `podman exited with code ${result.exitCode}`);
        return undefined;
      }
      return result;
    } catch (error) {
      warn(action, error);
      return undefined;
    }
  };

  const listed = await bestEffort("list app images", [
    "image", "list", "--filter", `reference=${repository}:*`, "--format", "{{.Tag}}",
  ]);
  if (listed) {
    const tags = listed.stdout.split(/\r?\n/).filter(Boolean);
    const legacy = tags
      .filter((value) => /^release-\d{13}-[a-f0-9]{12}$/.test(value))
      .sort((left, right) => Number(right.split("-")[1]) - Number(left.split("-")[1]));
    let previousCommit = previous?.metadata?.commit.slice(0, 12);
    if (previous && !previousCommit) {
      for (const legacyTag of legacy) {
        const inspected = await bestEffort(`inspect ${repository}:${legacyTag}`, [
          "image", "inspect", "--format", "{{.Id}}", `${repository}:${legacyTag}`,
        ]);
        if (inspected?.stdout.trim() === previous.imageId) {
          previousCommit = legacyTag.slice(-12);
          break;
        }
      }
    }

    const rollbackTag = previous && previousCommit && app.releaseRetention > 1
      ? `rollback-${retentionTimestamp}-${previousCommit}`
      : undefined;
    const taggedRollback = rollbackTag && previous
      ? await bestEffort("tag rollback image", ["image", "tag", previous.imageId, `${repository}:${rollbackTag}`])
      : undefined;
    if (taggedRollback && rollbackTag) {
      armRollbackExpiry(`${repository}:${rollbackTag}`, retentionTimestamp + ROLLBACK_RETENTION_MS, dependencies);
    }
    const retainedTag = taggedRollback
      ? rollbackTag
      : previous && app.releaseRetention > 1
        ? tags.filter((value) => /^rollback-\d{13}-[a-f0-9]{12}$/.test(value))
          .sort((left, right) => Number(right.split("-")[1]) - Number(left.split("-")[1]))[0] ?? legacy[0]
        : undefined;

    const staleTags = tags.filter((value) =>
      (/^(?:release|rollback)-\d{13}-[a-f0-9]{12}$/.test(value) && value !== retainedTag)
      || value.startsWith("staging-"));
    const superseded = new Set(staleTags.flatMap((value) => {
      const revision = /([a-f0-9]{12,40})$/.exec(value)?.[1];
      return revision ? [revision.slice(0, 12)] : [];
    }));
    const stale = new Set(staleTags.map((value) => `${repository}:${value}`));
    if (removeCurrentUpload) stale.add(uploadedImage(appId, commit));
    const uploads = await bestEffort("list uploaded images", [
      "image", "list", "--filter", `reference=${uploadRepository}:*`, "--format", "{{.Tag}}",
    ]);
    if (uploads) {
      for (const uploadTag of uploads.stdout.split(/\r?\n/).filter((value) => /^[a-f0-9]{40}$/.test(value))) {
        if (superseded.has(uploadTag.slice(0, 12))) stale.add(`${uploadRepository}:${uploadTag}`);
      }
    }
    for (const imageName of stale) await bestEffort(`remove ${imageName}`, ["image", "rm", imageName]);
  } else if (removeCurrentUpload) {
    await bestEffort("remove current upload tag", ["image", "rm", uploadedImage(appId, commit)]);
  }
  await bestEffort("prune dangling images", ["image", "prune", "--force"], 60_000);
}

function metadataFromEnvironment(environment: string[]): DeployMetadata | undefined {
  const commit = environment.find((value) => value.startsWith("SHIBUMI_COMMIT="))?.slice("SHIBUMI_COMMIT=".length);
  const deployedAt = environment.find((value) => value.startsWith("SHIBUMI_DEPLOYED_AT="))?.slice("SHIBUMI_DEPLOYED_AT=".length);
  if (!commit || !/^[a-f0-9]{40}$/.test(commit) || !deployedAt) return undefined;
  const timestamp = new Date(deployedAt);
  if (Number.isNaN(timestamp.valueOf()) || timestamp.toISOString() !== deployedAt) return undefined;
  return { commit, deployedAt };
}

async function runningRelease(
  app: AppConfig,
  composeExecutable: string,
  compose: string[],
  options: CommandOptions,
  dependencies: DeployDependencies,
): Promise<RunningRelease | undefined> {
  const container = await dependencies.runner.run(
    composeExecutable,
    [...compose, "ps", "--quiet", app.service],
    { ...options, capture: true },
  );
  let containerId = container.exitCode === 0 ? container.stdout.trim().split(/\s+/)[0] : undefined;
  if (!containerId) {
    const labeled = await dependencies.runner.run("podman", [
      "container", "list",
      "--filter", `label=io.podman.compose.project=${app.composeProject}`,
      "--filter", `label=io.podman.compose.service=${app.service}`,
      "--format", "{{.ID}}",
    ], { capture: true });
    containerId = labeled.exitCode === 0 ? labeled.stdout.trim().split(/\s+/)[0] : undefined;
  }
  if (!containerId) return undefined;
  const [imageId, config] = await Promise.all([
    dependencies.runner.run("podman", ["container", "inspect", "--format", "{{.Image}}", containerId], { capture: true }),
    dependencies.runner.run(
      "podman",
      ["container", "inspect", "--format", "{{.Config.Image}}\n{{range .Config.Env}}{{println .}}{{end}}", containerId],
      { capture: true },
    ),
  ]);
  const [imageName, ...environment] = config.stdout.trim().split(/\r?\n/);
  if (imageId.exitCode !== 0 || config.exitCode !== 0 || !imageId.stdout.trim() || !imageName) return undefined;
  return { imageId: imageId.stdout.trim(), imageName, metadata: metadataFromEnvironment(environment) };
}

async function restoreRelease(
  app: AppConfig,
  release: RunningRelease | undefined,
  composeExecutable: string,
  compose: string[],
  options: CommandOptions,
  appEnv: Record<string, string>,
  dependencies: DeployDependencies,
): Promise<void> {
  try {
    if (!release) {
      await runChecked(dependencies, "restore", composeExecutable, [...compose, "down"], options);
      return;
    }
    await runChecked(dependencies, "restore", "podman", ["image", "tag", release.imageId, release.imageName], { capture: true });
    await runChecked(
      dependencies,
      "restore",
      composeExecutable,
      [...compose, "up", "-d", "--no-build", "--force-recreate", "--no-deps", app.service],
      { ...options, input: composeOverride(app.service, release.imageName, release.metadata, appEnv) },
    );
    await waitForHealth(app, dependencies);
  } catch (error) {
    throw new DeploymentError("restore", `previous release could not be restored: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function composeOverride(service: string, image?: string, metadata?: DeployMetadata, appEnv: Record<string, string> = {}): string {
  const envEntries: Array<[string, string]> = [];
  if (metadata) {
    envEntries.push(["SHIBUMI_COMMIT", metadata.commit], ["SHIBUMI_DEPLOYED_AT", metadata.deployedAt]);
  }
  // App-managed env (shis env set) overrides nothing Shibumi owns: the two
  // SHIBUMI_* keys are reserved and win over any stored value of the same name.
  for (const [key, value] of Object.entries(appEnv)) {
    if (key !== "SHIBUMI_COMMIT" && key !== "SHIBUMI_DEPLOYED_AT") envEntries.push([key, value]);
  }
  const environment =
    envEntries.length > 0
      ? `    environment:\n${envEntries.map(([key, value]) => `      ${key}: ${JSON.stringify(value)}`).join("\n")}`
      : undefined;
  const properties = [image && `    image: ${JSON.stringify(image)}`, environment].filter(Boolean).join("\n");
  return `services:\n  ${JSON.stringify(service)}:\n${properties}\n`;
}

function composeInvocation(
  appId: string,
  app: AppConfig,
  image?: string,
  metadata?: DeployMetadata,
  appEnv: Record<string, string> = {},
): {
  executable: string;
  compose: string[];
  options: CommandOptions;
} {
  const [executable, ...prefix] = app.composeCommand;
  const compose = [...prefix, "--project-name", app.composeProject, "--file", composePath(app)];
  const options: CommandOptions = { env: { SHIBUMI_PORT: String(app.hostPort) } };
  if (image || metadata || Object.keys(appEnv).length > 0) {
    compose.push("--file", "-");
    options.input = composeOverride(app.service, image, metadata, appEnv);
  }
  return { executable, compose, options };
}

// Reads the per-app env store from the server config directory. Runs on the
// server as the app user, so homedir() is correct.
function loadAppEnv(appId: string): Record<string, string> {
  return readAppEnv(appEnvPath(join(homedir(), ".config", "shibumi-server"), appId));
}

export async function rollbackToPreviousImage(
  appId: string,
  app: AppConfig,
  dependencies: DeployDependencies,
  onTarget?: (commit: string) => void | Promise<void>,
): Promise<string> {
  const startedAt = Date.now();
  const appEnv = loadAppEnv(appId);
  let invocation = composeInvocation(appId, app, app.deploymentMode === "prebuilt" ? runtimeImage(appId) : undefined, undefined, appEnv);
  let { executable: composeExecutable, compose, options } = invocation;
  await runChecked(dependencies, "config", composeExecutable, [...compose, "config", "--quiet"], options);
  const current = await runningRelease(app, composeExecutable, compose, options, dependencies);
  if (!current) throw new DeploymentError("rollback", "cannot find the running application image");

  const repository = `localhost/shibumi-server/${appId}`;
  const listed = await runChecked(
    dependencies,
    "rollback",
    "podman",
    ["image", "list", "--filter", `reference=${repository}:*`, "--format", "{{.Tag}}"],
    { capture: true },
  );
  const tags = listed.stdout.split(/\r?\n/)
    .filter((tag) => /^(?:rollback|release)-\d{13}-[a-f0-9]{12}$/.test(tag))
    .sort((left, right) => Number(right.split("-")[1]) - Number(left.split("-")[1]));
  let previous: { imageId: string; commitPrefix: string } | undefined;
  for (const tag of tags) {
    const inspected = await runChecked(
      dependencies,
      "rollback",
      "podman",
      ["image", "inspect", "--format", "{{.Id}}", `${repository}:${tag}`],
      { capture: true },
    );
    const imageId = inspected.stdout.trim();
    if (imageId && imageId !== current.imageId) {
      previous = { imageId, commitPrefix: tag.slice(-12) };
      break;
    }
  }
  if (!previous) throw new DeploymentError("rollback", "no previous application image is retained");

  const resolved = await runChecked(
    dependencies,
    "rollback",
    "git",
    ["-C", app.checkout, "rev-parse", "--verify", `${previous.commitPrefix}^{commit}`],
    { capture: true },
  );
  const commit = resolved.stdout.trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new DeploymentError("rollback", "retained image commit cannot be resolved");

  await onTarget?.(commit);
  invocation = composeInvocation(
    appId,
    app,
    app.deploymentMode === "prebuilt" ? runtimeImage(appId) : undefined,
    { commit, deployedAt: new Date(startedAt).toISOString() },
    appEnv,
  );
  ({ executable: composeExecutable, compose, options } = invocation);
  await dependencies.onStage?.("rollback");
  const replacementStartedAt = Date.now();
  try {
    await runChecked(dependencies, "rollback", "podman", ["image", "tag", previous.imageId, current.imageName], { capture: true });
    await runChecked(
      dependencies,
      "rollback",
      composeExecutable,
      [...compose, "up", "-d", "--no-build", "--force-recreate", "--no-deps", app.service],
      options,
    );
    await dependencies.onStage?.("health");
    await waitForHealth(app, dependencies);
    await dependencies.onOutput?.("health", retryBudgetSummary("Rollback healthy", Date.now() - replacementStartedAt));
  } catch (error) {
    await restoreRelease(app, current, composeExecutable, compose, options, appEnv, dependencies);
    await dependencies.onOutput?.("restore", retryBudgetSummary("Previous release restored", Date.now() - replacementStartedAt));
    throw error;
  }
  await retainRollbackImage(appId, app, current, commit, startedAt, false, dependencies);
  return commit;
}

export async function deploy(
  appId: string,
  app: AppConfig,
  commit: string,
  dependencies: DeployDependencies,
): Promise<void> {
  const startedAt = Date.now();
  const appEnv = loadAppEnv(appId);
  let metadata: DeployMetadata = { commit, deployedAt: new Date(startedAt).toISOString() };
  await dependencies.onStage?.("preflight");
  await checkResources(app, dependencies);
  const git = (args: string[], stage: string, capture = false) =>
    runChecked(dependencies, stage, "git", ["-C", app.checkout, ...args], { capture });

  const status = await git(["status", "--porcelain"], "checkout", true);
  if (status.stdout.trim()) throw new DeploymentError("checkout", "deployment checkout has local changes");

  await git(["fetch", "--prune", "origin", app.ref], "fetch");
  const fetched = await git(["rev-parse", "FETCH_HEAD"], "verify", true);
  if (fetched.stdout.trim().toLowerCase() !== commit) {
    throw new DeploymentError("verify", "fetched branch no longer matches the webhook commit");
  }
  await git(["reset", "--hard", commit], "checkout");

  let invocation = composeInvocation(appId, app, undefined, metadata, appEnv);
  let sourceTree: string | undefined;
  if (app.deploymentMode === "prebuilt") {
    const tree = await git(["rev-parse", `${commit}^{tree}`], "verify", true);
    sourceTree = tree.stdout.trim().toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(sourceTree)) throw new DeploymentError("verify", "commit source tree cannot be resolved");
    await dependencies.onStage?.("image");
    let uploaded: Awaited<ReturnType<typeof inspectPrebuiltImageMetadata>>;
    try {
      uploaded = await inspectPrebuiltImageMetadata(dependencies.runner, appId, commit, app.repository, sourceTree);
    } catch (error) {
      throw new DeploymentError("image", `${error instanceof Error ? error.message : String(error)}. Upload it with bun ship, then retry.`);
    }
    metadata = { ...metadata, commit: uploaded.revision };
    invocation = composeInvocation(appId, app, uploaded.image, metadata, appEnv);
  }

  let { executable: composeExecutable, compose, options } = invocation;
  await runChecked(dependencies, "config", composeExecutable, [...compose, "config", "--quiet"], options);
  if (app.deploymentMode === "build") {
    await runChecked(
      dependencies,
      "build",
      composeExecutable,
      [...compose, "build"],
      { ...options, timeoutMs: app.buildTimeoutMs },
    );
  }
  if (app.testCommand) {
    await runChecked(
      dependencies,
      "test",
      composeExecutable,
      [...compose, "run", "--rm", app.service, ...app.testCommand],
      options,
    );
  }

  const previous = await runningRelease(app, composeExecutable, compose, options, dependencies);
  if (app.deploymentMode === "prebuilt") {
    const uploaded = await inspectPrebuiltImageMetadata(dependencies.runner, appId, commit, app.repository, sourceTree);
    const runtime = runtimeImage(appId);
    metadata = { ...metadata, commit: uploaded.revision };
    await runChecked(dependencies, "image", "podman", ["image", "tag", uploaded.image, runtime], { capture: true });
    invocation = composeInvocation(appId, app, runtime, metadata, appEnv);
    ({ executable: composeExecutable, compose, options } = invocation);
  }
  const replacementStartedAt = Date.now();
  try {
    // Two steps so sibling services (a database, an IRC server) survive deploys. The first `up` creates
    // anything missing and only recreates services whose config changed. The second forces the app
    // container alone; podman-compose applies --force-recreate to dependencies unless --no-deps is set.
    const noBuild = app.deploymentMode === "prebuilt" ? ["--no-build"] : [];
    await runChecked(dependencies, "start", composeExecutable, [...compose, "up", "-d", ...noBuild, "--remove-orphans"], options);
    await runChecked(dependencies, "start", composeExecutable, [...compose, "up", "-d", ...noBuild, "--force-recreate", "--no-deps", app.service], options);
    await dependencies.onStage?.("health");
    await waitForHealth(app, dependencies);
    await dependencies.onOutput?.("health", retryBudgetSummary("Replacement healthy", Date.now() - replacementStartedAt));
  } catch (error) {
    await restoreRelease(app, previous, composeExecutable, compose, options, appEnv, dependencies);
    if (previous) await dependencies.onOutput?.("restore", retryBudgetSummary("Previous release restored", Date.now() - replacementStartedAt));
    throw error;
  }
  await retainRollbackImage(appId, app, previous, commit, startedAt, app.deploymentMode === "prebuilt", dependencies);

  dependencies.logger.info("deployment succeeded", {
    app: appId,
    commit,
    durationMs: Date.now() - startedAt,
  });
}

export function defaultDeployDependencies(logger: DeploymentLogger = console): DeployDependencies {
  return {
    runner: new BunCommandRunner(),
    resources: new HostResourceInspector(),
    fetch,
    sleep: (milliseconds) => Bun.sleep(milliseconds),
    logger,
  };
}
