import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../../connection/runtime";

const STALE_TIME_MS = 5_000;
const IDLE_TTL_MS = 60_000;

export const notebooksForProject = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-notes:notebooks",
  tag: WS_METHODS.notesListNotebooks,
  staleTimeMs: STALE_TIME_MS,
  idleTtlMs: IDLE_TTL_MS,
});

export const notebookForThread = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-notes:notebook-for-thread",
  tag: WS_METHODS.notesNotebookForThread,
  staleTimeMs: STALE_TIME_MS,
  idleTtlMs: IDLE_TTL_MS,
});

export const notesForNotebook = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-notes:notes",
  tag: WS_METHODS.notesListNotes,
  staleTimeMs: STALE_TIME_MS,
  idleTtlMs: IDLE_TTL_MS,
});

export const createNotebook = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:fork-notes:create-notebook",
  tag: WS_METHODS.notesCreateNotebook,
});

export const linkThread = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:fork-notes:link-thread",
  tag: WS_METHODS.notesLinkThread,
});

export const createNote = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:fork-notes:create-note",
  tag: WS_METHODS.notesCreateNote,
});

export const updateNote = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:fork-notes:update-note",
  tag: WS_METHODS.notesUpdateNote,
});

export const deleteNote = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:fork-notes:delete-note",
  tag: WS_METHODS.notesDeleteNote,
});
