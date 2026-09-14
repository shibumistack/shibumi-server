import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import { BunCommandRunner, deploy, DeploymentError, ROLLBACK_RETENTION_MS, retryBudgetSummary, rollbackToPreviousImage, scheduleRollbackImageExpiry, type CommandOptions, type CommandResult, type CommandRunner, type DeployDependencies, type Fetcher, type ResourceAvailability } from "../src/deploy";

const commit = "a".repeat(40);
const sourceTree = "b".repeat(40);
const app: AppConfig = {
  repository: "owner/repo",
  ref: "refs/heads/main",
  checkout: "/srv/shibumi/apps/myapp",
  composeFile: "compose.yaml",
  composeCommand: ["podman", "compose"],
  composeProject: "myapp",
  service: "web",
  hostPort: 9100,
  testCommand: ["bun", "test"],
  healthUrl: "http://127.0.0.1:9100/healthz",
  secretEnvironmentVariable: "SHIBUMI_SECRET_MYAPP",
  minimumFreeMemoryMb: 1_536,
  minimumFreeDiskMb: 4_096,
  buildTimeoutMs: 600_000,
  healthAttempts: 2,
  healthIntervalMs: 10,
  releaseRetention: 2,
  deploymentMode: "build",
};

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; options?: CommandOptions }> = [];
  responses: CommandResult[] = [];

  async run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
    this.calls.push({ command, args, options });
    const response = this.responses.shift();
    if (response) return response;
    if (command === "git" && args.at(-1) === `${commit}^{tree}`) return { exitCode: 0, stdout: `${sourceTree}\n`, stderr: "" };
    if (args.includes("ps") && args.includes("--quiet")) return { exitCode: 0, stdout: "container-id\n", stderr: "" };
    if (args[0] === "container" && args[1] === "list") return { exitCode: 0, stdout: "container-id\n", stderr: "" };
    if (args[0] === "container" && args[1] === "inspect") {
      return {
        exitCode: 0,
        stdout: args[3] === "{{.Image}}"
          ? "sha256:image-id\n"
          : `localhost/myapp:web\nSHIBUMI_COMMIT=${"b".repeat(40)}\nSHIBUMI_DEPLOYED_AT=2025-01-01T00:00:00.000Z\n`,
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

function dependencies(
  runner: FakeRunner,
  fetchImplementation: Fetcher = async () => new Response("ok"),
  resources: ResourceAvailability = { memoryBytes: 8 * 1024 ** 3, diskBytes: 100 * 1024 ** 3 },
): DeployDependencies {
  return {
    runner,
    resources: { available: async () => resources },
    fetch: fetchImplementation,
    sleep: async () => {},
    logger: { info() {}, error() {} },
  };
}

describe("deployment pipeline", () => {
  test("fetches the exact commit, builds, tests, starts, and checks health", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
    ];

    const output: string[] = [];
    const deps = dependencies(runner);
    deps.onOutput = async (stage, line) => { output.push(`${stage}: ${line}`); };
    await deploy("myapp", app, commit, deps);

    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(/^health: Replacement healthy in \d+ms; Caddy retry budget 20000ms; headroom \d+ms$/);
    expect(retryBudgetSummary("Replacement healthy", 20_250)).toBe("Replacement healthy in 20250ms; Caddy retry budget 20000ms; exceeded by 250ms");
    const calls = runner.calls.map(({ command, args }) => [command, ...args]);
    expect(calls.slice(0, 7)).toEqual([
      ["git", "-C", app.checkout, "status", "--porcelain"],
      ["git", "-C", app.checkout, "fetch", "--prune", "origin", app.ref],
      ["git", "-C", app.checkout, "rev-parse", "FETCH_HEAD"],
      ["git", "-C", app.checkout, "reset", "--hard", commit],
      ["podman", "compose", "--project-name", "myapp", "--file", `${app.checkout}/compose.yaml`, "--file", "-", "config", "--quiet"],
      ["podman", "compose", "--project-name", "myapp", "--file", `${app.checkout}/compose.yaml`, "--file", "-", "build"],
      ["podman", "compose", "--project-name", "myapp", "--file", `${app.checkout}/compose.yaml`, "--file", "-", "run", "--rm", "web", "bun", "test"],
    ]);
    expect(calls[7]).toEqual(["podman", "compose", "--project-name", "myapp", "--file", `${app.checkout}/compose.yaml`, "--file", "-", "ps", "--quiet", "web"]);
    expect(calls[10]).toEqual(["podman", "compose", "--project-name", "myapp", "--file", `${app.checkout}/compose.yaml`, "--file", "-", "up", "-d", "--remove-orphans", "--force-recreate", "web"]);
    expect(calls[11]).toEqual(["podman", "image", "list", "--filter", "reference=localhost/shibumi-server/myapp:*", "--format", "{{.Tag}}"]);
    expect(calls[12]?.slice(0, 4)).toEqual(["podman", "image", "tag", "sha256:image-id"]);
    expect(calls[12]?.[4]).toMatch(/^localhost\/shibumi-server\/myapp:rollback-\d{13}-b{12}$/);
    expect(calls[13]).toEqual(["podman", "image", "list", "--filter", "reference=localhost/shibumi-server/upload/myapp:*", "--format", "{{.Tag}}"]);
    expect(calls[14]).toEqual(["podman", "image", "prune", "--force"]);
    const start = runner.calls.find(({ args }) => args.includes("up"));
    expect(start?.options?.env).toEqual({ SHIBUMI_PORT: "9100" });
    expect(start?.options?.input).toContain(`SHIBUMI_COMMIT: ${JSON.stringify(commit)}`);
    const deployedAt = /SHIBUMI_DEPLOYED_AT: "([^"]+)"/.exec(start?.options?.input ?? "")?.[1];
    expect(deployedAt && new Date(deployedAt).toISOString()).toBe(deployedAt);
    expect(runner.calls.find(({ args }) => args.at(-1) === "build")?.options?.timeoutMs).toBe(600_000);
  });

  test("runs an exact prebuilt image without building on the server", async () => {
    class PrebuiltRunner extends FakeRunner {
      override async run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
        if (command === "podman" && args[0] === "image" && args[1] === "inspect") {
          this.calls.push({ command, args, options });
          const image = `localhost/shibumi-server/upload/myapp:${commit}`;
          return {
            exitCode: 0,
            stdout: JSON.stringify([{
              Os: "linux",
              Architecture: process.arch === "arm64" ? "arm64" : "amd64",
              RepoTags: [image],
              Labels: {
                "dev.shibumistack.app-id": "myapp",
                "org.opencontainers.image.revision": commit,
                "org.opencontainers.image.source": "https://github.com/owner/repo",
                "dev.shibumistack.source-tree": sourceTree,
              },
            }]),
            stderr: "",
          };
        }
        return super.run(command, args, options);
      }
    }
    const runner = new PrebuiltRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
    ];

    await deploy("myapp", { ...app, deploymentMode: "prebuilt" }, commit, dependencies(runner));

    expect(runner.calls.some(({ args }) => args.includes("build"))).toBe(false);
    const testCall = runner.calls.find(({ args }) => args.includes("run"));
    expect(testCall?.options?.input).toContain(`localhost/shibumi-server/upload/myapp:${commit}`);
    const start = runner.calls.find(({ args }) => args.includes("up"));
    expect(start?.args).toContain("--no-build");
    expect(start?.options?.input).toContain("localhost/shibumi-server/runtime/myapp:current");
    expect(start?.options?.input).toContain(`SHIBUMI_COMMIT: ${JSON.stringify(commit)}`);
    expect(runner.calls.some(({ command, args }) => command === "podman"
      && args.slice(0, 4).join(" ") === `image tag localhost/shibumi-server/upload/myapp:${commit} localhost/shibumi-server/runtime/myapp:current`)).toBe(true);
    expect(runner.calls.some(({ command, args }) => command === "podman"
      && args.slice(0, 3).join(" ") === `image rm localhost/shibumi-server/upload/myapp:${commit}`)).toBe(true);
  });

  test("does not start a prebuilt deployment when its exact image is missing", async () => {
    class MissingImageRunner extends FakeRunner {
      override async run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
        if (command === "podman" && args[0] === "image" && args[1] === "inspect") {
          this.calls.push({ command, args, options });
          return { exitCode: 1, stdout: "", stderr: "missing" };
        }
        return super.run(command, args, options);
      }
    }
    const runner = new MissingImageRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
    ];

    await expect(deploy("myapp", { ...app, deploymentMode: "prebuilt" }, commit, dependencies(runner))).rejects.toEqual(
      new DeploymentError("image", `prebuilt image ${commit} is not loaded. Upload it with bun ship, then retry.`),
    );
    expect(runner.calls.some(({ args }) => args.includes("up"))).toBe(false);
  });

  test("always validates Compose and allows app-owned tests to be omitted", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
    ];

    await deploy("myapp", { ...app, testCommand: undefined }, commit, dependencies(runner));

    expect(runner.calls.some(({ args }) => args.includes("config") && args.includes("--quiet"))).toBe(true);
    expect(runner.calls.some(({ args }) => args.includes("run"))).toBe(false);
    expect(runner.calls.some(({ args }) => args.includes("up"))).toBe(true);
    expect(runner.calls.at(-1)?.args).toEqual(["image", "prune", "--force"]);
  });

  test("does not fail a healthy deployment when image cleanup fails", async () => {
    class PruneFailingRunner extends FakeRunner {
      override async run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
        const result = await super.run(command, args, options);
        if (command === "podman" && args[0] === "image" && args[1] === "prune") {
          return { exitCode: 1, stdout: "", stderr: "cleanup failed" };
        }
        return result;
      }
    }
    const runner = new PruneFailingRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
    ];

    await expect(deploy("myapp", app, commit, dependencies(runner))).resolves.toBeUndefined();
    expect(runner.calls.at(-1)?.args).toEqual(["image", "prune", "--force"]);
  });

  test("keeps only current and one rollback image while removing legacy tags", async () => {
    class RetentionRunner extends FakeRunner {
      override async run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
        if (command === "podman" && args[0] === "image" && args[1] === "list") {
          this.calls.push({ command, args, options });
          return {
            exitCode: 0,
            stdout: args[3] === "reference=localhost/shibumi-server/upload/myapp:*"
              ? `${"b".repeat(40)}\n${"c".repeat(40)}\n${"f".repeat(40)}\n`
              : [
                  "release-1700000004000-bbbbbbbbbbbb",
                  "release-1700000003000-cccccccccccc",
                  "release-1700000002000-dddddddddddd",
                  "release-1700000001000-eeeeeeeeeeee",
                  "staging-1700000003000-cccccccccccc",
                ].join("\n"),
            stderr: "",
          };
        }
        return super.run(command, args, options);
      }
    }
    const runner = new RetentionRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
    ];

    await deploy("myapp", app, commit, dependencies(runner));

    const removed = runner.calls
      .filter(({ command, args }) => command === "podman" && args[0] === "image" && args[1] === "rm")
      .map(({ args }) => args[2]);
    expect(removed).toEqual([
      "localhost/shibumi-server/myapp:release-1700000004000-bbbbbbbbbbbb",
      "localhost/shibumi-server/myapp:release-1700000003000-cccccccccccc",
      "localhost/shibumi-server/myapp:release-1700000002000-dddddddddddd",
      "localhost/shibumi-server/myapp:release-1700000001000-eeeeeeeeeeee",
      "localhost/shibumi-server/myapp:staging-1700000003000-cccccccccccc",
      `localhost/shibumi-server/upload/myapp:${"b".repeat(40)}`,
      `localhost/shibumi-server/upload/myapp:${"c".repeat(40)}`,
    ]);
    const rollbackTag = runner.calls.find(({ args }) => args[0] === "image" && args[1] === "tag" && args[2] === "sha256:image-id")?.args[3];
    expect(rollbackTag).toMatch(/^localhost\/shibumi-server\/myapp:rollback-\d{13}-b{12}$/);
    expect(removed).not.toContain(`localhost/shibumi-server/upload/myapp:${"f".repeat(40)}`);
    expect(runner.calls.at(-1)?.args).toEqual(["image", "prune", "--force"]);
  });

  test("deletes rollback image after twelve hours", async () => {
    const timestamp = 1_700_000_000_000;
    class ExpiryRunner extends FakeRunner {
      override async run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
        if (args[0] === "image" && args[1] === "list") {
          this.calls.push({ command, args, options });
          return { exitCode: 0, stdout: `rollback-${timestamp}-bbbbbbbbbbbb\n`, stderr: "" };
        }
        return super.run(command, args, options);
      }
    }
    const runner = new ExpiryRunner();

    await scheduleRollbackImageExpiry("myapp", dependencies(runner), timestamp + ROLLBACK_RETENTION_MS);

    expect(runner.calls.map(({ args }) => args)).toContainEqual([
      "image", "rm", `localhost/shibumi-server/myapp:rollback-${timestamp}-bbbbbbbbbbbb`,
    ]);
    expect(runner.calls.at(-1)?.args).toEqual(["image", "prune", "--force"]);
  });

  test("stops before building when the Compose config is invalid", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "invalid compose" },
    ];

    await expect(deploy("myapp", app, commit, dependencies(runner))).rejects.toThrow("config failed: invalid compose");
    expect(runner.calls.some(({ args }) => args.includes("build"))).toBe(false);
  });

  test("refuses to deploy when available memory is below the configured floor", async () => {
    const runner = new FakeRunner();
    await expect(deploy(
      "myapp",
      app,
      commit,
      dependencies(runner, undefined, { memoryBytes: 1_535 * 1024 ** 2, diskBytes: 100 * 1024 ** 3 }),
    )).rejects.toEqual(
      new DeploymentError("preflight", "resource preflight failed: 1535 MiB memory available; 1536 MiB required"),
    );
    expect(runner.calls).toHaveLength(0);
  });

  test("refuses to deploy when available disk is below the configured floor", async () => {
    const runner = new FakeRunner();
    await expect(deploy(
      "myapp",
      app,
      commit,
      dependencies(runner, undefined, { memoryBytes: 8 * 1024 ** 3, diskBytes: 4_095 * 1024 ** 2 }),
    )).rejects.toThrow("4095 MiB disk available; 4096 MiB required");
    expect(runner.calls).toHaveLength(0);
  });

  test("refuses a dirty checkout before fetching", async () => {
    const runner = new FakeRunner();
    runner.responses = [{ exitCode: 0, stdout: " M compose.yaml\n", stderr: "" }];
    await expect(deploy("myapp", app, commit, dependencies(runner))).rejects.toThrow("local changes");
    expect(runner.calls).toHaveLength(1);
  });

  test("rejects a fetched SHA mismatch", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" },
    ];
    await expect(deploy("myapp", app, commit, dependencies(runner))).rejects.toThrow("no longer matches");
    expect(runner.calls).toHaveLength(3);
  });

  test("restores the previous retained image without fetching or building", async () => {
    const previousCommit = "b".repeat(40);
    class RollbackRunner extends FakeRunner {
      runningImage = "sha256:current";

      override async run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
        if (command === "podman" && args[0] === "container" && args[1] === "inspect") {
          this.calls.push({ command, args, options });
          return {
            exitCode: 0,
            stdout: args[3] === "{{.Image}}"
              ? `${this.runningImage}\n`
              : `localhost/myapp:web\nSHIBUMI_COMMIT=${commit}\nSHIBUMI_DEPLOYED_AT=2025-01-01T00:00:00.000Z\n`,
            stderr: "",
          };
        }
        if (command === "podman" && args[0] === "image" && args[1] === "list") {
          this.calls.push({ command, args, options });
          return { exitCode: 0, stdout: "release-1700000002000-aaaaaaaaaaaa\nrelease-1700000001000-bbbbbbbbbbbb\n", stderr: "" };
        }
        if (command === "podman" && args[0] === "image" && args[1] === "inspect") {
          this.calls.push({ command, args, options });
          return { exitCode: 0, stdout: `${args[4].endsWith("aaaaaaaaaaaa") ? "sha256:current" : "sha256:previous"}\n`, stderr: "" };
        }
        if (command === "git" && args.includes("rev-parse")) {
          this.calls.push({ command, args, options });
          return { exitCode: 0, stdout: `${previousCommit}\n`, stderr: "" };
        }
        if (args.includes("up")) this.runningImage = "sha256:previous";
        return super.run(command, args, options);
      }
    }
    const runner = new RollbackRunner();
    let target = "";

    await expect(rollbackToPreviousImage("myapp", app, dependencies(runner), (commit) => { target = commit; })).resolves.toBe(previousCommit);

    expect(target).toBe(previousCommit);
    expect(runner.calls.some(({ command, args }) => command === "podman" && args.slice(0, 4).join(" ") === "image tag sha256:previous localhost/myapp:web")).toBe(true);
    const rollbackStart = runner.calls.find(({ args }) => args.includes("--no-build") && args.includes("--force-recreate"));
    expect(rollbackStart?.options?.input).toContain(`SHIBUMI_COMMIT: ${JSON.stringify(previousCommit)}`);
    expect(rollbackStart?.options?.input).not.toContain(`SHIBUMI_COMMIT: ${JSON.stringify(commit)}`);
    expect(runner.calls.some(({ command, args }) => command === "git" && args.includes("fetch"))).toBe(false);
    expect(runner.calls.some(({ args }) => args.includes("build"))).toBe(false);
  });

  test("does not start the app when the build fails", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "broken build" },
    ];
    await expect(deploy("myapp", app, commit, dependencies(runner))).rejects.toEqual(
      new DeploymentError("build", "build failed: broken build"),
    );
    expect(runner.calls.some(({ args }) => args.includes("up"))).toBe(false);
  });

  test("cancels a build that exceeds its deadline", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 137, stdout: "", stderr: "", timedOut: true },
    ];
    await expect(deploy("myapp", app, commit, dependencies(runner))).rejects.toEqual(
      new DeploymentError("build", "build timed out after 600000ms"),
    );
    expect(runner.calls.some(({ args }) => args.includes("up"))).toBe(false);
  });

  test("does not start the app when its container tests fail", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "failed tests" },
    ];
    await expect(deploy("myapp", app, commit, dependencies(runner))).rejects.toThrow("test failed: failed tests");
    expect(runner.calls.some(({ args }) => args.includes("up"))).toBe(false);
  });

  test("the Bun runner kills a process after its timeout", async () => {
    const result = await new BunCommandRunner().run(
      process.execPath,
      ["--eval", "await Bun.sleep(10_000)"],
      { capture: true, timeoutMs: 25 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  test("finds the previous standalone podman-compose image by labels before restoring it", async () => {
    class StandaloneRunner extends FakeRunner {
      override async run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
        if (command === "podman-compose" && args.includes("ps")) {
          this.calls.push({ command, args, options });
          return { exitCode: 2, stdout: "", stderr: "unrecognized arguments: web" };
        }
        return super.run(command, args, options);
      }
    }
    const runner = new StandaloneRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
    ];
    let healthChecks = 0;
    const health: Fetcher = async () => new Response("health", { status: ++healthChecks <= app.healthAttempts ? 503 : 200 });

    await expect(deploy("myapp", { ...app, composeCommand: ["podman-compose"] }, commit, dependencies(runner, health))).rejects.toThrow("health check did not pass");

    expect(runner.calls.some(({ command, args }) => command === "podman" && args[0] === "container" && args[1] === "list")).toBe(true);
    expect(runner.calls.some(({ command, args }) => command === "podman" && args[0] === "image" && args[1] === "tag" && args[2] === "sha256:image-id")).toBe(true);
    expect(runner.calls.some(({ args }) => args.includes("--no-build") && args.includes("--force-recreate"))).toBe(true);
  });

  test("restores the previous image when the new release fails health checks", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
    ];
    let healthChecks = 0;
    const health: Fetcher = async () => new Response("health", { status: ++healthChecks <= app.healthAttempts ? 503 : 200 });

    await expect(deploy("myapp", app, commit, dependencies(runner, health))).rejects.toThrow("health check did not pass");

    expect(runner.calls.some(({ command, args }) => command === "podman" && args[0] === "image" && args[1] === "tag" && args[2] === "sha256:image-id")).toBe(true);
    expect(runner.calls.some(({ args }) => args.includes("--no-build") && args.includes("--force-recreate"))).toBe(true);
  });

  test("reports a health timeout after starting", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
    ];
    const unavailable: Fetcher = async () => new Response("no", { status: 503 });
    await expect(deploy("myapp", app, commit, dependencies(runner, unavailable))).rejects.toThrow("health check did not pass");
    expect(runner.calls.some(({ args }) => args[0] === "image" && args[1] === "prune")).toBe(false);
  });
});
