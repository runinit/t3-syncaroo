import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const repoRoot = resolveRepoRoot();
const helperPath = join(repoRoot, "vendor/t3-v2-native-helper.mjs");

function resolveRepoRoot(): string {
  return new URL("../..", import.meta.url).pathname;
}

function callHelper(request: Record<string, unknown>): Record<string, any> {
  const output = execFileSync(process.execPath, [helperPath], {
    cwd: repoRoot,
    input: JSON.stringify(request),
    encoding: "utf8",
  });
  return JSON.parse(output) as Record<string, any>;
}

export function replayCliPrefixWithNativeSuffix(input: {
  importedDbPath: string;
  replayDbPath: string;
  threadId: string;
  projectId: string;
  workspace: string;
  suffixEvents: Array<Record<string, any>>;
}): Record<string, any> {
  const first = callHelper({ op: "inspect", dbPath: input.importedDbPath, threadIds: [input.threadId] });
  const imported = first.threads?.[0];
  if (!imported?.exists || !Array.isArray(imported.events) || imported.events.length === 0) {
    throw new Error("Public CLI import did not produce a replayable native thread event prefix.");
  }
  const selectedEventIds = imported.events.map((event: Record<string, unknown>) => event.id);
  const detailed = callHelper({ op: "inspect", dbPath: input.importedDbPath,
    threadIds: [input.threadId], selectedEventIds });
  const prefix = detailed.threads?.[0]?.selectedEventDetails?.map((entry: Record<string, any>) => entry.event);
  if (!Array.isArray(prefix) || prefix.length !== selectedEventIds.length
    || prefix.filter((event: Record<string, any>) => event.type === "thread.created").length !== 1) {
    throw new Error("Pinned T3 helper could not return the exact CLI-created event prefix.");
  }
  if (input.suffixEvents.some((event) => event.type === "thread.created" || event.type === "project.created"
    || String(event.id).startsWith("agent-session-import:v2:"))) {
    throw new Error("Native suffix fixture must not replace CLI-created thread or imported-prefix events.");
  }
  const threadCreated = prefix.find((event: Record<string, any>) => event.type === "thread.created");
  if (threadCreated.payload.projectId !== input.projectId || threadCreated.threadId !== input.threadId) {
    throw new Error("CLI-created thread identity does not match the requested replay target.");
  }
  mkdirSync(dirname(input.replayDbPath), { recursive: true });
  const projectEvent = {
    commandId: `command:cli-native-replay:${input.projectId}`,
    commandType: "project.create",
    acceptedAt: threadCreated.payload.createdAt,
    event: {
      sequence: 1,
      eventId: `event:cli-native-replay:${input.projectId}:project`,
      aggregateKind: "project",
      aggregateId: input.projectId,
      occurredAt: threadCreated.payload.createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: input.projectId,
        title: "CLI native continuation fixture",
        workspaceRoot: input.workspace,
        defaultModelSelection: null,
        scripts: [],
        createdAt: threadCreated.payload.createdAt,
        updatedAt: threadCreated.payload.createdAt,
      },
    },
  };
  const written = callHelper({ op: "write", dbPath: input.replayDbPath,
    events: [...prefix, ...input.suffixEvents], projectEvent });
  if (written.ok !== true || !written.projections?.[0]?.records) {
    throw new Error(`Pinned EventSink could not replay the CLI prefix and native suffix: ${written.error ?? written.outcome ?? "unknown error"}`);
  }
  return written.projections[0];
}
