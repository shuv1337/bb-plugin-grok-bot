import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  experimental_formatConformanceReport as formatConformanceReport,
  experimental_runBridgeConformance as runBridgeConformance,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { CapturedBridgeJsonRpcOutput } from "@get-bb/plugin-sdk/provider-bridge/testing";

import { handleLine } from "../src/provider-bridge.js";
import { FAKE_BOT, FAKE_GROUP, installFakeBackend, writeConfig } from "./fake-backend.js";
import { setFetchForTesting } from "../src/grok-api.js";


let output: CapturedBridgeJsonRpcOutput;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bb-grok-bot-conformance-"));
  process.env.FAKE_GBOT_STATE = join(workDir, "state.json");
  writeConfig(workDir, [FAKE_BOT, FAKE_GROUP]);
  installFakeBackend(process.env.FAKE_GBOT_STATE);
  output = captureBridgeJsonRpcOutput();
});

afterEach(() => {
  output.restore();
  setFetchForTesting(null);
  rmSync(workDir, { recursive: true, force: true });
});

it("passes the canonical protocol suite", async () => {
  const report = await runBridgeConformance({
    transport: { send: handleLine, takeMessages: output.takeMessages },
    providerId: "grok-bot",
    session: {
      cwd: workDir,
      promptInput: [{ type: "text", text: "say hello", mentions: [] }],
      options: {
        model: FAKE_BOT,
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
        providerOptions: { pollIntervalMs: 1_000 },
      },
    },
    timeoutMs: 20_000,
  });
  output.restore();
  console.info(`grok-bot bridge conformance:\n${formatConformanceReport(report)}`);
  const failing = report.results.filter((result) => result.status === "fail");
  expect(failing).toEqual([]);
  const statusById = Object.fromEntries(
    report.results.map((result) => [result.id, result.status]),
  );
  for (const rule of [
    "handshake/initialize",
    "session/start-identity",
    "session/start-identity-announced",
    "turn/lifecycle",
    "events/schema-valid",
    "item/opens-before-delta",
    "stop/release-not-interrupted",
    "session/resume-identity",
    "session/resume-id-uniqueness",
  ]) {
    expect([rule, statusById[rule]]).toEqual([rule, "pass"]);
  }
  expect(report.passed).toBe(true);
}, 120_000);
