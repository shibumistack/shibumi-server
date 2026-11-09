import { createHmac } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import { BunCommandRunner, defaultDeployDependencies } from "../src/deploy";
import { WebhookService } from "../src/server";

const integrationTest = process.env.SHIBUMI_INTEGRATION === "1" ? test : test.skip;

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate a test port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function command(commandName: string, args: string[], cwd?: string): Promise<string> {
  const process = Bun.spawn([commandName, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${commandName} ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

integrationTest("deploys a signed webhook through a disposable Git checkout and real rootless Podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "shibumi-integration-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const checkout = join(root, "checkout");
  const composeProject = `shibumi-test-${process.pid}`;
  const hostPort = await availablePort();
  const fixture = join(import.meta.dir, "integration", "fixture");

  try {
    await cp(fixture, source, { recursive: true });
    await command("git", ["init", "--initial-branch=main"], source);
    await command("git", ["config", "user.name", "Shibumi Test"], source);
    await command("git", ["config", "user.email", "test@example.com"], source);
    await command("git", ["add", "."], source);
    await command("git", ["commit", "-m", "integration fixture"], source);
    const commit = await command("git", ["rev-parse", "HEAD"], source);
    await command("git", ["clone", "--bare", source, remote]);
    await command("git", ["clone", remote, checkout]);

    const app: AppConfig = {
      repository: "example/myapp",
      ref: "refs/heads/main",
      checkout,
      composeFile: "compose.yaml",
      composeCommand: process.env.SHIBUMI_COMPOSE_COMMAND === "podman-compose"
        ? ["podman-compose"]
        : ["podman", "compose"],
      composeProject,
      service: "web",
      hostPort,
      testCommand: ["bun", "--eval", "if (!(await Bun.file('server.ts').exists())) process.exit(1)"],
      healthUrl: `http://127.0.0.1:${hostPort}/healthz`,
      secretEnvironmentVariable: "SHIBUMI_SECRET_MYAPP",
      minimumFreeMemoryMb: 256,
      minimumFreeDiskMb: 256,
      buildTimeoutMs: 60_000,
      healthAttempts: 30,
      healthIntervalMs: 250,
      releaseRetention: 2,
      deploymentMode: "build",
    };

    const secret = "integration-secret".repeat(3);
    const body = JSON.stringify({
      ref: app.ref,
      after: commit,
      repository: { full_name: app.repository },
    });
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    const logger = { info: (...args: unknown[]) => console.info(...args), error: (...args: unknown[]) => console.error(...args) };
    const service = new WebhookService(
      {
        listen: { hostname: "127.0.0.1", port: 8787, maxBodyBytes: 1_048_576 },
        apps: { myapp: app },
      },
      {
        environment: { SHIBUMI_SECRET_MYAPP: secret },
        deployDependencies: defaultDeployDependencies(logger),
        logger,
      },
    );
    const response = await service.handle(new Request("http://127.0.0.1:8787/hooks/github/myapp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body,
    }));
    expect(response.status).toBe(202);
    await service.waitForIdle();
    expect(await (await fetch(`http://127.0.0.1:${hostPort}/`)).text()).toBe("shibumi integration fixture");
  } finally {
    const composeFile = join(checkout, "compose.yaml");
    const composeCommand = process.env.SHIBUMI_COMPOSE_COMMAND === "podman-compose"
      ? ["podman-compose"]
      : ["podman", "compose"];
    await new BunCommandRunner().run(
      composeCommand[0],
      [...composeCommand.slice(1), "--project-name", composeProject, "--file", composeFile, "down", "--remove-orphans", "--rmi", "local"],
      { env: { SHIBUMI_PORT: String(hostPort) } },
    ).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
