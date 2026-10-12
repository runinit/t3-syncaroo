import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SessionOutcome, SessionOutcomeKind, SessionOutcomeRecord, SourceSummary, SourceName, SourceDiscoveryOutcome } from "../core/types.js";

export interface FileWalkFailure {
  path: string;
  code: "source-path-changed" | "source-permission-denied" | "source-scan-failed";
}

export interface FileWalkResult {
  files: string[];
  failures: FileWalkFailure[];
}

export function discoveryOutcome(
  source: SourceName,
  filePath: string,
  code: string,
  kind: SessionOutcomeKind = "failed",
  sessionId?: string,
  workspace?: string,
): SourceDiscoveryOutcome {
  let message: string;
  let nextAction: string;
  if (code === "source-path-changed") {
    message = "The source file changed or disappeared during discovery.";
    nextAction = "Wait for the provider to finish writing the session, then rediscover it.";
  } else if (code === "source-permission-denied") {
    message = "The source file or folder could not be read because access was denied.";
    nextAction = "Grant read access to the provider history folder, then rediscover.";
  } else if (code === "unsupported-session-format") {
    message = "The file does not contain a supported Codex session header.";
    nextAction = "Verify this is a Codex session file with a readable session header, then rediscover.";
  } else if (code === "child-session-contained-by-parent") {
    message = "This Codex child session is represented by its parent conversation and is not imported separately.";
    nextAction = "Import the parent conversation to include its supported child-session history.";
  } else if (code === "claude-sidechain-session") {
    message = "This Claude transcript contains only subagent sidechain history, which is not supported as a standalone conversation.";
    nextAction = "Import the main Claude conversation instead; standalone subagent transcripts are not supported.";
  } else if (code === "source-changed-during-read") {
    message = "The source file changed while it was being read.";
    nextAction = "Wait for the provider to finish writing the session, then rediscover and retry.";
  } else if (code === "source-scan-failed") {
    message = "The provider history folder could not be scanned.";
    nextAction = "Check that the provider history folder exists and is readable, then rediscover.";
  } else {
    message = "The source transcript could not be read or parsed.";
    nextAction = "Check that the transcript is readable JSONL and unchanged, then rediscover.";
  }
  const outcome: SessionOutcome = { kind, phase: "discovery", code, message, nextAction };
  return { source, ...(sessionId ? { sessionId } : {}), ...(workspace ? { workspace } : {}), sourcePath: filePath, displayName: basename(filePath), outcome };
}

export function fileErrorCode(error: unknown): FileWalkFailure["code"] {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "ENOENT") return "source-path-changed";
  if (code === "EACCES" || code === "EPERM") return "source-permission-denied";
  return "source-scan-failed";
}

export function sourceFileErrorCode(error: unknown): string {
  if (error instanceof Error && error.message === "SOURCE_CHANGED_DURING_READ") return "source-changed-during-read";
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "ENOENT") return "source-path-changed";
  if (code === "EACCES" || code === "EPERM") return "source-permission-denied";
  return "source-unreadable";
}

export function sourceLoadFailureOutcome(summary: SourceSummary): SessionOutcomeRecord {
  const outcome: SessionOutcome = {
    kind: "failed",
    phase: "load",
    code: "source-load-failed",
    message: "The selected transcript could not be loaded, so it was not included in this operation.",
    nextAction: "Check that the transcript is still readable, then retry this session.",
  };
  return { source: summary.source, sessionId: summary.id, workspace: summary.workspace, sourcePath: summary.path, displayName: basename(summary.path), outcome };
}

export function missingSourceSessionOutcome(source: SourceName, sessionId: string, workspace?: string): SessionOutcomeRecord {
  return {
    source,
    sessionId,
    ...(workspace ? { workspace } : {}),
    displayName: sessionId,
    outcome: {
      kind: "failed",
      phase: "discovery",
      code: "source-session-not-found",
      message: "The requested session was not found among the discovered source files for this selection.",
      nextAction: "Check the session ID and workspace filters, then rediscover before retrying.",
    },
  };
}

export async function walkFilesWithFailures(root: string, extension: string): Promise<FileWalkResult> {
  const output: string[] = [];
  const failures: FileWalkFailure[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      const code = fileErrorCode(error);
      // A missing provider root is a normal empty installation. A directory
      // disappearing after traversal began is a changing source and is visible.
      if (!(directory === root && code === "source-path-changed")) failures.push({ path: directory, code });
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && entry.name.endsWith(extension)) output.push(path);
      }),
    );
  };
  await visit(root);
  return { files: output, failures };
}

export async function walkFiles(root: string, extension: string): Promise<string[]> {
  return (await walkFilesWithFailures(root, extension)).files;
}
