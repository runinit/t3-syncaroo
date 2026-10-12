import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SessionOutcome, SourceName, SourceDiscoveryOutcome } from "../core/types.js";

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
  kind: "failed" | "unsupported" = "failed",
  sessionId?: string,
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
  } else if (code === "source-scan-failed") {
    message = "The provider history folder could not be scanned.";
    nextAction = "Check that the provider history folder exists and is readable, then rediscover.";
  } else {
    message = "The source transcript could not be read or parsed.";
    nextAction = "Check that the transcript is readable JSONL and unchanged, then rediscover.";
  }
  const outcome: SessionOutcome = { kind, phase: "discovery", code, message, nextAction };
  return { source, ...(sessionId ? { sessionId } : {}), sourcePath: filePath, displayName: basename(filePath), outcome };
}

export function fileErrorCode(error: unknown): FileWalkFailure["code"] {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "ENOENT") return "source-path-changed";
  if (code === "EACCES" || code === "EPERM") return "source-permission-denied";
  return "source-scan-failed";
}

export function sourceFileErrorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "ENOENT") return "source-path-changed";
  if (code === "EACCES" || code === "EPERM") return "source-permission-denied";
  return "source-unreadable";
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
