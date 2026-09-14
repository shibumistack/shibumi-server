import { createHmac } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config";
import type { CommandOptions, CommandResult, CommandRunner, DeployDependencies } from "../src/deploy";
import { WebhookService } from "../src/server";
import { DeploymentQueueStore } from "../src/queue";
import { DeploymentStatusStore } from "../src/status";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const secret = "s".repeat(32);
const commit = "a".repeat(40);
const config = parseConfig({
  listen: { hostname: "127.0.0.1", port: 8787, maxBodyBytes: 1_000 },
  apps: {
    myapp: {
      repository: "owner/repo",
      ref: "refs/heads/main",
      checkout: "/srv/shibumi/apps/myapp",
      composeFile: "compose.yaml",
      composeProject: "myapp",
      service: "web",
      hostPort: 9100,
      testCommand: ["bun", "test"],
      healthUrl: "http://127.0.0.1:9100/healthz",
      secretEnvironmentVariable: "SHIBUMI_SECRET_MYAPP",
      healthAttempts: 1,
      healthIntervalMs: 10,
    },
  },
});

function payload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    ref: "refs/heads/main",
    after: commit,
    repository: { full_name: "owner/repo" },
    ...overrides,
  });
}

let deliverySequence = 0;

function request(body: string, event = "push", signatureSecret = secret, deliveryId?: string): Request {
  const signature = createHmac("sha256", signatureSecret).update(body).digest("hex");
  deliverySequence += 1;
  const delivery = deliveryId ?? `00000000-0000-4000-8000-${String(deliverySequence).padStart(12, "0")}`;
  return new Request("https://example.com/hooks/github/myapp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": delivery,
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body,
  });
}

class SuccessfulRunner implements CommandRunner {
  calls = 0;

  async run(_command: string, args: string[], _options?: CommandOptions): Promise<CommandResult> {
    this.calls += 1;
    if (args.includes("rev-parse")) return { exitCode: 0, stdout: `${commit}\n`, stderr: "" };
    if (args.includes("ps") && args.includes("--quiet")) return { exitCode: 0, stdout: "container-id\n", stderr: "" };
    if (args[0] === "container" && args[1] === "list") return { exitCode: 0, stdout: "container-id\n", stderr: "" };
    if (args[0] === "container" && args[1] === "inspect") return { exitCode: 0, stdout: "sha256:image-id\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

function dependencies(runner: CommandRunner = new SuccessfulRunner()): DeployDependencies {
  return {
    runner,
    resources: { available: async () => ({ memoryBytes: 8 * 1024 ** 3, diskBytes: 100 * 1024 ** 3 }) },
    fetch: async () => new Response("ok"),
    sleep: async () => {},
    logger: { info() {}, error() {} },
  };
}

function service(runner?: CommandRunner) {
  return new WebhookService(config, {
    environment: { SHIBUMI_SECRET_MYAPP: secret },
    deployDependencies: dependencies(runner),
    logger: { info() {}, error() {} },
  });
}

describe("webhook server", () => {
  test("accepts a signed push and runs asynchronously", async () => {
    const receiver = service();
    const response = await receiver.handle(request(payload()));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted", app: "myapp", commit });
    await receiver.waitForIdle();
  });

  test("accepts GitHub's signed ping without deploying", async () => {
    const receiver = service();
    const response = await receiver.handle(request("{}", "ping"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("rejects missing or malformed authentication headers", async () => {
    const unsigned = new Request("https://example.com/hooks/github/myapp", {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "push" },
      body: payload(),
    });
    expect((await service().handle(unsigned)).status).toBe(400);
    expect((await service().handle(request(payload(), "push", "wrong-secret".repeat(3)))).status).toBe(401);
    expect((await service().handle(request(payload(), "push", secret, "not-a-guid"))).status).toBe(400);
  });

  test("rejects an invalid signature before payload handling", async () => {
    const response = await service().handle(request(payload(), "push", "wrong-secret".repeat(3)));
    expect(response.status).toBe(401);
  });

  test("rejects repository and branch mismatches", async () => {
    expect((await service().handle(request(payload({ repository: { full_name: "other/repo" } })))).status).toBe(400);
    expect((await service().handle(request(payload({ ref: "refs/heads/other" })))).status).toBe(400);
  });

  test("rejects oversized request bodies", async () => {
    const body = JSON.stringify({ padding: "x".repeat(2_000) });
    const response = await service().handle(request(body));
    expect(response.status).toBe(413);
  });

  test("acknowledges a replayed valid delivery without deploying twice", async () => {
    const runner = new SuccessfulRunner();
    const receiver = service(runner);
    const delivery = "72d3162e-cc78-11e3-81ab-4c9367dc0958";

    expect((await receiver.handle(request(payload(), "push", secret, delivery))).status).toBe(202);
    await receiver.waitForIdle();
    const replay = await receiver.handle(request(payload(), "push", secret, delivery));

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ status: "duplicate", app: "myapp", delivery });
    expect(runner.calls).toBe(15);
  });

  test("allows a failed delivery to be retried", async () => {
    class FailingRunner extends SuccessfulRunner {
      override async run(_command: string, _args: string[], _options?: CommandOptions): Promise<CommandResult> {
        this.calls += 1;
        return { exitCode: 1, stdout: "", stderr: "failed" };
      }
    }
    const runner = new FailingRunner();
    const receiver = service(runner);
    const delivery = "82d3162e-cc78-11e3-81ab-4c9367dc0958";

    expect((await receiver.handle(request(payload(), "push", secret, delivery))).status).toBe(202);
    await receiver.waitForIdle();
    expect((await receiver.handle(request(payload(), "push", secret, delivery))).status).toBe(202);
    await receiver.waitForIdle();
    expect(runner.calls).toBe(2);
  });

  test("queues the latest commit while the same app is deploying", async () => {
    let releaseBuild!: () => void;
    const buildBlocked = new Promise<void>((resolve) => { releaseBuild = resolve; });
    class BlockingRunner extends SuccessfulRunner {
      builds = 0;

      override async run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
        if (args.includes("rev-parse")) return { exitCode: 0, stdout: `${this.builds === 0 ? commit : "c".repeat(40)}\n`, stderr: "" };
        if (command === "podman" && args.at(-1) === "build") {
          this.builds += 1;
          if (this.builds === 1) await buildBlocked;
        }
        return super.run(command, args, options);
      }
    }

    const directory = await mkdtemp(join(tmpdir(), "shibumi-server-queue-"));
    roots.push(directory);
    const receiver = new WebhookService(config, {
      environment: { SHIBUMI_SECRET_MYAPP: secret },
      deployDependencies: dependencies(new BlockingRunner()),
      logger: { info() {}, error() {} },
      statusStore: new DeploymentStatusStore(join(directory, "status")),
      queueStore: new DeploymentQueueStore(join(directory, "queue")),
    });
    expect((await receiver.handle(request(payload()))).status).toBe(202);
    const queuedCommit = "c".repeat(40);
    const queued = await receiver.handle(request(payload({ after: queuedCommit })));
    expect(queued.status).toBe(202);
    expect(await queued.json()).toEqual({ status: "queued", app: "myapp", commit: queuedCommit });
    expect(await new DeploymentStatusStore(join(directory, "status")).read("myapp", queuedCommit))
      .toMatchObject({ commit, queuedCommit });
    releaseBuild();
    await receiver.waitForIdle();
    expect(await new DeploymentStatusStore(join(directory, "status")).read("myapp", queuedCommit))
      .toMatchObject({ commit: queuedCommit, state: "succeeded" });
    expect(await new DeploymentQueueStore(join(directory, "queue")).read("myapp")).toBeUndefined();
  });
});
