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

export interface ProviderTextWithPinnedNotesInput {
  readonly text: string;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}

/**
 * The provider text for a turn: the user text plus the pinned notes of the thread's notebook.
 * A notes store that fails or dies is logged and skipped; the turn still starts with the text.
 */
export const providerTextWithPinnedNotes = Effect.fn("VisionNotes.providerTextWithPinnedNotes")(
  function* (
    input: ProviderTextWithPinnedNotesInput,
    limits: PinnedNotesLimits = DEFAULT_PINNED_NOTES_LIMITS,
  ) {
    const notes = yield* NotesService;
    const envelope = yield* notes.notebookForThread(input.threadId, input.projectId).pipe(
      Effect.flatMap((notebook) =>
        Effect.map(notes.listNotes(notebook.notebookId), (all) =>
          renderPinnedNotesForProvider({ notebook, notes: all }, limits),
        ),
      ),
      Effect.tapError((error) => Effect.logWarning("pinned notes skipped for this turn", error)),
      Effect.orElseSucceed(() => null),
      Effect.catchDefect((defect) =>
        Effect.logWarning("pinned notes skipped for this turn", defect).pipe(Effect.as(null)),
      ),
    );
    return appendPinnedNotes(input.text, envelope);
  },
);
