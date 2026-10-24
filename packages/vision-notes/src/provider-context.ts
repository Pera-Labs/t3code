import * as Effect from "effect/Effect";

import type { Note, Notebook, ProjectId, ThreadId } from "@t3tools/contracts";

import { NotesService } from "./service.ts";

/**
 * Pinned notes of a thread's notebook travel to the provider after the user text, in an
 * envelope the agent can act on: the `id` of every entry works with the `t3_note_*` tools.
 * The shape mirrors the upstream composer context envelope so one escaping rule covers both.
 */
export const PINNED_NOTES_TAG = "t3_notes";
export const PINNED_NOTE_TAG = "note";
export const PINNED_NOTES_VERSION = "1";

export interface PinnedNotesLimits {
  /** Pinned notes beyond this count are counted in the `omitted` attribute. */
  readonly maxNotes: number;
  /** Longer bodies are cut and end with a truncation marker. */
  readonly maxBodyChars: number;
  /** No further note is added once the rendered bodies would pass this budget. */
  readonly maxTotalBodyChars: number;
}

export const DEFAULT_PINNED_NOTES_LIMITS: PinnedNotesLimits = {
  maxNotes: 8,
  maxBodyChars: 2_000,
  maxTotalBodyChars: 8_000,
};

// A body may mention the envelope tags but cannot open or close them; the composer context
// envelope that can precede this block is protected by the same rule.
const GUARDED_TAG_OPENING = /<(?=\/?(?:t3_notes|note|t3_context|context)\b)/gi;

export const escapePinnedNoteBody = (text: string): string =>
  text.replace(GUARDED_TAG_OPENING, "&lt;");

export const escapePinnedNoteAttribute = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const renderBody = (body: string, maxBodyChars: number): string => {
  const text = body.trimEnd();
  if (text.length <= maxBodyChars) {
    return escapePinnedNoteBody(text);
  }
  const removed = text.length - maxBodyChars;
  const kept = escapePinnedNoteBody(text.slice(0, maxBodyChars).trimEnd());
  return `${kept}\n[note truncated: ${removed} more characters]`;
};

export interface RenderPinnedNotesInput {
  readonly notebook: Pick<Notebook, "notebookId" | "title">;
  readonly notes: ReadonlyArray<Note>;
}

/**
 * The envelope for the pinned notes in `input.notes`, in the order given (the service lists
 * pinned notes first, most recently updated first). Null when nothing is pinned.
 */
export const renderPinnedNotesForProvider = (
  input: RenderPinnedNotesInput,
  limits: PinnedNotesLimits = DEFAULT_PINNED_NOTES_LIMITS,
): string | null => {
  const pinned = input.notes.filter((note) => note.pinned);
  if (pinned.length === 0) {
    return null;
  }
  const entries: Array<string> = [];
  let budget = limits.maxTotalBodyChars;
  for (const note of pinned) {
    if (entries.length >= limits.maxNotes) {
      break;
    }
    const body = renderBody(note.body, limits.maxBodyChars);
    if (entries.length > 0 && body.length > budget) {
      break;
    }
    budget -= body.length;
    const opening = `<${PINNED_NOTE_TAG} id="${escapePinnedNoteAttribute(note.noteId)}" title="${escapePinnedNoteAttribute(note.title)}" updatedAt="${escapePinnedNoteAttribute(note.updatedAt)}">`;
    const closing = `</${PINNED_NOTE_TAG}>`;
    entries.push((body === "" ? [opening, closing] : [opening, body, closing]).join("\n"));
  }
  const omitted = pinned.length - entries.length;
  const attributes = [
    `version="${PINNED_NOTES_VERSION}"`,
    `notebook="${escapePinnedNoteAttribute(input.notebook.title)}"`,
    `notebookId="${escapePinnedNoteAttribute(input.notebook.notebookId)}"`,
    ...(omitted > 0 ? [`omitted="${omitted}"`] : []),
  ];
  return [
    `<${PINNED_NOTES_TAG} ${attributes.join(" ")}>`,
    ...entries,
    `</${PINNED_NOTES_TAG}>`,
  ].join("\n");
};

/** The user text followed by the envelope, or the text alone when there is none. */
export const appendPinnedNotes = (text: string, envelope: string | null): string =>
  envelope === null ? text : text === "" ? envelope : `${text}\n\n${envelope}`;

/**
 * Which pinned set each native session has received, per server process. The key is the
 * provider's native thread id; the value is the envelope last delivered, "" when nothing was
 * pinned. A restart forgets everything, so the next turn of every session sends the full set.
 */
export interface PinnedNotesMemory {
  readonly get: (nativeThreadId: string) => string | undefined;
  readonly set: (nativeThreadId: string, envelope: string) => void;
}

export const DEFAULT_PINNED_NOTES_MEMORY_CAPACITY = 256;

/** Bounded; the session served longest ago is forgotten once the capacity is passed. */
export const makePinnedNotesMemory = (
  capacity: number = DEFAULT_PINNED_NOTES_MEMORY_CAPACITY,
): PinnedNotesMemory => {
  const entries = new Map<string, string>();
  return {
    get: (nativeThreadId) => entries.get(nativeThreadId),
    set: (nativeThreadId, envelope) => {
      entries.delete(nativeThreadId);
      entries.set(nativeThreadId, envelope);
      if (entries.size > capacity) {
        const oldest = entries.keys().next();
        if (!oldest.done) {
          entries.delete(oldest.value);
        }
      }
    },
  };
};

const renderNotebookMarker = (
  notebook: Pick<Notebook, "notebookId" | "title">,
  flag: "unchanged" | "cleared",
  hint: string,
): string =>
  [
    `<${PINNED_NOTES_TAG} version="${PINNED_NOTES_VERSION}" notebook="${escapePinnedNoteAttribute(notebook.title)}" notebookId="${escapePinnedNoteAttribute(notebook.notebookId)}" ${flag}="true">`,
    hint,
    `</${PINNED_NOTES_TAG}>`,
  ].join("\n");

/** One line for a session that already holds the current pinned set. */
export const renderPinnedNotesUnchangedForProvider = (
  notebook: Pick<Notebook, "notebookId" | "title">,
): string =>
  renderNotebookMarker(
    notebook,
    "unchanged",
    "Pinned notes unchanged since they were last shown in this session; t3_note_list returns them again.",
  );

/** One line for a session whose pinned notes were all unpinned since it last saw them. */
export const renderPinnedNotesClearedForProvider = (
  notebook: Pick<Notebook, "notebookId" | "title">,
): string =>
  renderNotebookMarker(
    notebook,
    "cleared",
    "No pinned notes remain in this notebook; earlier pinned notes no longer apply.",
  );

export interface PinnedNotesForSessionInput {
  readonly notebook: Pick<Notebook, "notebookId" | "title">;
  /** The full envelope for the current pinned set, null when nothing is pinned. */
  readonly envelope: string | null;
  /** The provider's native thread that receives the text; undefined when this turn starts it. */
  readonly nativeThreadId: string | undefined;
  readonly memory: PinnedNotesMemory;
}

export interface PinnedNotesForSession {
  /** What follows the user text: the full envelope, a marker, or nothing. */
  readonly envelope: string | null;
  /** Records the delivery; run it once the text is handed to the provider. */
  readonly delivered: () => void;
}

const noDelivery = (): void => undefined;

/**
 * The full envelope goes to a session that starts with this turn, that this process has not
 * served yet, or whose pinned set changed since. A session that already holds the current set
 * gets the one-line unchanged marker, and one whose notes were all unpinned gets the cleared
 * marker once. A delivery counts only when `delivered` runs, so a turn that never reaches the
 * provider repeats the full set next time.
 */
export const pinnedNotesForSession = (input: PinnedNotesForSessionInput): PinnedNotesForSession => {
  const nativeThreadId = input.nativeThreadId;
  if (nativeThreadId === undefined) {
    return { envelope: input.envelope, delivered: noDelivery };
  }
  const current = input.envelope ?? "";
  const delivered = () => input.memory.set(nativeThreadId, current);
  const previous = input.memory.get(nativeThreadId);
  if (previous === undefined) {
    return { envelope: input.envelope, delivered };
  }
  if (previous === current) {
    return {
      envelope:
        input.envelope === null ? null : renderPinnedNotesUnchangedForProvider(input.notebook),
      delivered,
    };
  }
  return {
    envelope: input.envelope ?? renderPinnedNotesClearedForProvider(input.notebook),
    delivered,
  };
};

export interface ProviderTextWithPinnedNotesInput {
  readonly text: string;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}

export interface ProviderTurnTextWithPinnedNotesInput extends ProviderTextWithPinnedNotesInput {
  /** The provider's native thread that receives the text; undefined when this turn starts it. */
  readonly nativeThreadId: string | undefined;
  readonly memory: PinnedNotesMemory;
}

export interface ProviderTurnTextWithPinnedNotes {
  readonly text: string;
  /** Run once the text is handed to the provider; see pinnedNotesForSession. */
  readonly delivered: Effect.Effect<void>;
}

/**
 * The provider text for a turn: the user text plus the pinned notes of the thread's notebook,
 * in full or as a marker depending on what the native session already holds. A notes store
 * that fails or dies is logged and skipped; the turn still starts with the text.
 */
export const providerTurnTextWithPinnedNotes = Effect.fn(
  "VisionNotes.providerTurnTextWithPinnedNotes",
)(function* (
  input: ProviderTurnTextWithPinnedNotesInput,
  limits: PinnedNotesLimits = DEFAULT_PINNED_NOTES_LIMITS,
) {
  const notes = yield* NotesService;
  const forSession = yield* notes.notebookForThread(input.threadId, input.projectId).pipe(
    Effect.flatMap((notebook) =>
      Effect.map(notes.listNotes(notebook.notebookId), (all) =>
        pinnedNotesForSession({
          notebook,
          envelope: renderPinnedNotesForProvider({ notebook, notes: all }, limits),
          nativeThreadId: input.nativeThreadId,
          memory: input.memory,
        }),
      ),
    ),
    Effect.tapError((error) => Effect.logWarning("pinned notes skipped for this turn", error)),
    Effect.orElseSucceed(() => null),
    Effect.catchDefect((defect) =>
      Effect.logWarning("pinned notes skipped for this turn", defect).pipe(Effect.as(null)),
    ),
  );
  return {
    text: appendPinnedNotes(input.text, forSession?.envelope ?? null),
    delivered: forSession === null ? Effect.void : Effect.sync(forSession.delivered),
  };
});

const noSessionMemory = makePinnedNotesMemory();

/** The provider text with the full pinned set, for a caller without a native session to track. */
export const providerTextWithPinnedNotes = Effect.fn("VisionNotes.providerTextWithPinnedNotes")(
  function* (
    input: ProviderTextWithPinnedNotesInput,
    limits: PinnedNotesLimits = DEFAULT_PINNED_NOTES_LIMITS,
  ) {
    const turn = yield* providerTurnTextWithPinnedNotes(
      { ...input, nativeThreadId: undefined, memory: noSessionMemory },
      limits,
    );
    return turn.text;
  },
);
