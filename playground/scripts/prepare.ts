import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { isPhase } from "../types.ts";
import type { Phase } from "../types.ts";
import { environmentMatrix, workersDirectory } from "./lib/run-metadata.ts";
import {
  buildProfile,
  cloneInstalledProfile,
  copyCredentials,
  installPlugins,
  loadProviderPlan,
  mountRawTree,
  readPlaygroundConfig,
  registerWorkspaces,
  resetHome,
  startWeb,
  stopWeb,
  writeHomePatch,
  writeRoleFile,
  writePstackSettings,
  writeWorkerInstructions,
  CONFIG_FILE,
  type ProviderPlan,
} from "./lib/env.ts";
import { listScenarioIds } from "./lib/scenarios.ts";
import { computeWorkers } from "./lib/capacity.ts";
import {
  clearBootstrapReady,
  listWorkers,
  resetPhase,
  workerPaths,
  type WorkerPaths,
} from "./lib/worker.ts";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readPhase(paths: WorkerPaths): string {
  return existsSync(paths.phaseFile) ? readFileSync(paths.phaseFile, "utf8").trim() : "";
}

async function waitReachable(url: string): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" });
      return true;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
  }
  return false;
}

async function startWorkers(
  paths: WorkerPaths[],
  plan: ProviderPlan,
  port?: number,
): Promise<void> {
  const started = await Promise.all(
    paths.map(async (worker, index) => ({
      worker,
      ...(await startWeb(worker, plan, port === undefined ? 0 : port + index)),
    })),
  );
  const ports = started.map((entry) => entry.port);
  if (new Set(ports).size !== ports.length) throw new Error("workers bound duplicate ports");
  for (const entry of started) {
    if (!(await waitReachable(entry.url))) {
      throw new Error(`worker ${entry.worker.index} is not reachable at ${entry.url}`);
    }
    console.log(`[prepare] ${entry.worker.environmentId}/w${entry.worker.index} url=${entry.url}`);
  }
}

async function main(): Promise<void> {
  const phase = argValue("--phase") as Phase | undefined;
  if (!isPhase(phase)) {
    throw new Error(
      "usage: prepare.ts --phase raw|adapted --environment ID [--workers N] [--port N] [--reset|--reuse]",
    );
  }
  const environmentId = argValue("--environment");
  if (environmentId === undefined) throw new Error("--environment is required");
  const matrix = environmentMatrix(environmentId);
  clearBootstrapReady(matrix.id, phase);
  if (phase === "raw" && matrix.enabledPluginPackages.length > 0 && matrix.kind !== "capability") {
    throw new Error("raw only accepts additional packages in an explicit capability environment");
  }
  const enabledPackages =
    phase === "adapted"
      ? ["dsh-pstack", ...matrix.enabledPluginPackages]
      : matrix.enabledPluginPackages;
  const configFile = argValue("--config") ?? process.env.PLAYGROUND_CONFIG_FILE ?? CONFIG_FILE;
  const config = readPlaygroundConfig(configFile);
  const plan = loadProviderPlan(config);
  const workerFlag = argValue("--workers");
  const requested = workerFlag === undefined ? undefined : Number(workerFlag);
  const count = computeWorkers(requested).workers;
  const portFlag = argValue("--port");
  const port = portFlag === undefined ? undefined : Number(portFlag);
  if (
    port !== undefined &&
    (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || port + count - 1 > 65_535)
  ) {
    throw new Error("--port must be a port number that leaves room for every worker");
  }
  const reset = process.argv.includes("--reset");
  const reuse = process.argv.includes("--reuse");
  if (reset && reuse) throw new Error("--reset and --reuse are mutually exclusive");
  if (reuse) {
    const workers = Array.from({ length: count }, (_, index) =>
      workerPaths(index, matrix.id, phase),
    );
    for (const worker of workers) stopWeb(worker);
    // The reused profile points at the worker's raw mount outside the repo; refresh it so a
    // cleared temp root does not restart raw workers with missing skills.
    for (const worker of workers) {
      if (readPhase(worker) === "raw") mountRawTree(worker);
      writeWorkerInstructions(worker);
      writeRoleFile(worker, config);
      writePstackSettings(worker, phase === "adapted");
    }
    await startWorkers(workers, plan, port);
    return;
  }

  const workers = Array.from({ length: count }, (_, index) => workerPaths(index, matrix.id, phase));
  if (reset) {
    for (const worker of listWorkers({ environmentId: matrix.id, phase })) stopWeb(worker);
    resetPhase(matrix.id, phase);
  } else {
    for (const worker of listWorkers({ environmentId: matrix.id, phase })) {
      if (worker.index >= count) stopWeb(worker);
    }
  }
  mkdirSync(workersDirectory(), { recursive: true });
  let installed: WorkerPaths | null = null;
  for (const worker of workers) {
    if (reset) resetHome(worker);
    else mkdirSync(worker.home, { recursive: true });
    if (phase === "raw") mountRawTree(worker);
    buildProfile(worker, phase, enabledPackages, matrix.teamMode === true);
    writeFileSync(worker.phaseFile, `${phase}\n`);
    // Credentials stay with the host unless the config opts in, so workers start logged out.
    if (config.credentialsFile) copyCredentials(worker, config.credentialsFile);
    writeHomePatch(worker, plan, phase);
    writeRoleFile(worker, config);
    writePstackSettings(worker, phase === "adapted");
    registerWorkspaces(worker, listScenarioIds());
    if (enabledPackages.length > 0) {
      if (installed === null) {
        installPlugins(worker, matrix.versionExemptions ?? []);
        installed = worker;
      } else {
        cloneInstalledProfile(installed, worker);
      }
    }
  }
  await startWorkers(workers, plan, port);
  console.log(
    `[prepare] phase=${phase} environment=${matrix.id} workers=${count} model=${plan.main.provider}/${plan.main.model}[${plan.main.effort}]`,
  );
}

main().catch((error: unknown) => {
  console.error(`[prepare] ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
