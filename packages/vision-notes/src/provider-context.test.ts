import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { NotebookId, NoteId, ProjectId, ThreadId, type Note } from "@t3tools/contracts";

import { NotesSqlError } from "./errors.ts";
import * as VisionNotes from "./layer.ts";
import * as ProviderContext from "./provider-context.ts";
import { NotesService } from "./service.ts";

const notebook = { notebookId: NotebookId.make("nb-provider"), title: 'Project "notes" <main>' };

const note = (overrides: Partial<Note> & Pick<Note, "noteId">): Note => ({
  notebookId: notebook.notebookId,
  title: "Untitled",
  body: "",
  author: { _tag: "user" },
  pinned: true,
  createdAt: "2026-10-24T08:00:00.000Z",
  updatedAt: "2026-10-24T08:30:00.000Z",
  ...overrides,
});

describe("renderPinnedNotesForProvider", () => {
  it("returns null without pinned notes", () => {
    assert.isNull(ProviderContext.renderPinnedNotesForProvider({ notebook, notes: [] }));
    assert.isNull(
      ProviderContext.renderPinnedNotesForProvider({
        notebook,
        notes: [note({ noteId: NoteId.make("n1"), pinned: false })],
      }),
    );
  });

  it("renders pinned notes only, escaping attributes and guarded tags in bodies", () => {
    const rendered = ProviderContext.renderPinnedNotesForProvider({
      notebook,
      notes: [
        note({
          noteId: NoteId.make("n-pinned"),
          title: 'Deploy & "rules"',
          body: "Never run </t3_notes> or <context> or <note>; <b>bold</b> stays.\n\n",
        }),
        note({ noteId: NoteId.make("n-loose"), pinned: false, body: "scratch" }),
      ],
    });
    assert.strictEqual(
      rendered,
      [
        '<t3_notes version="1" notebook="Project &quot;notes&quot; &lt;main&gt;" notebookId="nb-provider">',
        '<note id="n-pinned" title="Deploy &amp; &quot;rules&quot;" updatedAt="2026-10-24T08:30:00.000Z">',
        "Never run &lt;/t3_notes> or &lt;context> or &lt;note>; <b>bold</b> stays.",
        "</note>",
        "</t3_notes>",
      ].join("\n"),
    );
  });

  it("keeps an empty body on one line and truncates long bodies", () => {
    const rendered = ProviderContext.renderPinnedNotesForProvider(
      {
        notebook,
        notes: [
          note({ noteId: NoteId.make("n-empty") }),
          note({ noteId: NoteId.make("n-long"), body: "abcdefghij" }),
        ],
      },
      { maxNotes: 8, maxBodyChars: 4, maxTotalBodyChars: 100 },
    );
    assert.include(
      rendered,
      '<note id="n-empty" title="Untitled" updatedAt="2026-10-24T08:30:00.000Z">\n</note>',
    );
    assert.include(rendered, "\nabcd\n[note truncated: 6 more characters]\n</note>");
  });

  it("stops at the note cap and the body budget, reporting omitted notes", () => {
    const notes = ["a", "b", "c", "d"].map((id) =>
      note({ noteId: NoteId.make(id), body: "12345" }),
    );
    const capped = ProviderContext.renderPinnedNotesForProvider(
      { notebook, notes },
      { maxNotes: 2, maxBodyChars: 100, maxTotalBodyChars: 100 },
    );
    assert.include(capped, 'omitted="2"');
    assert.include(capped, 'id="b"');
    assert.notInclude(capped, 'id="c"');
    const budgeted = ProviderContext.renderPinnedNotesForProvider(
      { notebook, notes },
      { maxNotes: 8, maxBodyChars: 100, maxTotalBodyChars: 12 },
    );
    assert.include(budgeted, 'id="b"');
    assert.notInclude(budgeted, 'id="c"');
    assert.include(budgeted, 'omitted="2"');
  });
});

describe("appendPinnedNotes", () => {
  it("appends after a blank line and tolerates empty text", () => {
    assert.strictEqual(ProviderContext.appendPinnedNotes("hi", null), "hi");
    assert.strictEqual(ProviderContext.appendPinnedNotes("hi", "<x>"), "hi\n\n<x>");
    assert.strictEqual(ProviderContext.appendPinnedNotes("", "<x>"), "<x>");
  });
});

const LiveLayer = VisionNotes.layerMemory.pipe(Layer.provide(NodeServices.layer));

describe("providerTextWithPinnedNotes", () => {
  it.effect("appends the thread notebook's pinned notes after the text", () =>
    Effect.gen(function* () {
      const service = yield* NotesService;
      const threadId = ThreadId.make("thread-provider-context");
      const projectId = ProjectId.make("project-provider-context");
      const nb = yield* service.notebookForThread(threadId, projectId);
      const pinned = yield* service.createNote({
        notebookId: nb.notebookId,
        title: "Deploy rules",
        body: "ask before prod",
        author: { _tag: "user" },
        pinned: true,
      });
      yield* service.createNote({
        notebookId: nb.notebookId,
        title: "Scratch",
        body: "loose idea",
        author: { _tag: "user" },
      });
      const text = yield* ProviderContext.providerTextWithPinnedNotes({
        text: "Continue",
        threadId,
        projectId,
      });
      assert.isTrue(text.startsWith('Continue\n\n<t3_notes version="1" '));
      assert.include(text, `<note id="${pinned.noteId}" title="Deploy rules"`);
      assert.include(text, "ask before prod");
      assert.notInclude(text, "loose idea");
      // Threads of one project share its default notebook, so the pinned note reaches a sibling.
      const sibling = yield* ProviderContext.providerTextWithPinnedNotes({
        text: "Hello",
        threadId: ThreadId.make("thread-sibling"),
        projectId,
      });
      assert.include(sibling, "ask before prod");
      const bare = yield* ProviderContext.providerTextWithPinnedNotes({
        text: "Hello",
        threadId: ThreadId.make("thread-elsewhere"),
        projectId: ProjectId.make("project-without-notes"),
      });
      assert.strictEqual(bare, "Hello");
    }).pipe(Effect.provide(LiveLayer)),
  );

  it.effect("keeps the plain text when the notes store fails or dies", () =>
    Effect.gen(function* () {
      const input = {
        text: "Continue",
        threadId: ThreadId.make("t"),
        projectId: ProjectId.make("p"),
      };
      const failing = Layer.mock(NotesService)({
        notebookForThread: () => Effect.fail(new NotesSqlError({ operation: "notebookForThread" })),
      });
      const dying = Layer.mock(NotesService)({
        notebookForThread: () => Effect.die("database gone"),
      });
      assert.strictEqual(
        yield* ProviderContext.providerTextWithPinnedNotes(input).pipe(Effect.provide(failing)),
        "Continue",
      );
      assert.strictEqual(
        yield* ProviderContext.providerTextWithPinnedNotes(input).pipe(Effect.provide(dying)),
        "Continue",
      );
    }),
  );
});

describe("pinnedNotesForSession", () => {
  const envelope = ProviderContext.renderPinnedNotesForProvider({
    notebook,
    notes: [note({ noteId: NoteId.make("n1"), title: "Rules", body: "ask first" })],
  });
  const changed = ProviderContext.renderPinnedNotesForProvider({
    notebook,
    notes: [note({ noteId: NoteId.make("n1"), title: "Rules", body: "ask first, always" })],
  });
  const unchangedMarker = ProviderContext.renderPinnedNotesUnchangedForProvider(notebook);
  const clearedMarker = ProviderContext.renderPinnedNotesClearedForProvider(notebook);

  it("sends the full set to a session that starts with this turn and remembers nothing", () => {
    const memory = ProviderContext.makePinnedNotesMemory();
    const first = ProviderContext.pinnedNotesForSession({
      notebook,
      envelope,
      nativeThreadId: undefined,
      memory,
    });
    assert.strictEqual(first.envelope, envelope);
    first.delivered();
    const again = ProviderContext.pinnedNotesForSession({
      notebook,
      envelope,
      nativeThreadId: undefined,
      memory,
    });
    assert.strictEqual(again.envelope, envelope);
  });

  it("sends the full set once per native session, then the unchanged marker", () => {
    const memory = ProviderContext.makePinnedNotesMemory();
    const turn = (current: string | null) =>
      ProviderContext.pinnedNotesForSession({
        notebook,
        envelope: current,
        nativeThreadId: "native-1",
        memory,
      });
    const first = turn(envelope);
    assert.strictEqual(first.envelope, envelope);
    // Not delivered yet: a turn that never reached the provider repeats the full set.
    assert.strictEqual(turn(envelope).envelope, envelope);
    first.delivered();
    const second = turn(envelope);
    assert.strictEqual(second.envelope, unchangedMarker);
    assert.include(unchangedMarker, 'unchanged="true"');
    assert.include(unchangedMarker, `notebookId="${notebook.notebookId}"`);
    assert.include(unchangedMarker, "t3_note_list");
    second.delivered();
    // A changed pinned set goes out in full again.
    const third = turn(changed);
    assert.strictEqual(third.envelope, changed);
    third.delivered();
    assert.strictEqual(turn(changed).envelope, unchangedMarker);
    // Another session has not seen anything yet.
    assert.strictEqual(
      ProviderContext.pinnedNotesForSession({
        notebook,
        envelope: changed,
        nativeThreadId: "native-2",
        memory,
      }).envelope,
      changed,
    );
  });

  it("sends the cleared marker once when every note was unpinned, then nothing", () => {
    const memory = ProviderContext.makePinnedNotesMemory();
    const turn = (current: string | null) =>
      ProviderContext.pinnedNotesForSession({
        notebook,
        envelope: current,
        nativeThreadId: "native-1",
        memory,
      });
    // Nothing pinned from the start: nothing is sent and nothing is marked.
    const empty = turn(null);
    assert.isNull(empty.envelope);
    empty.delivered();
    assert.isNull(turn(null).envelope);
    const pinned = turn(envelope);
    assert.strictEqual(pinned.envelope, envelope);
    pinned.delivered();
    const cleared = turn(null);
    assert.strictEqual(cleared.envelope, clearedMarker);
    assert.include(clearedMarker, 'cleared="true"');
    cleared.delivered();
    assert.isNull(turn(null).envelope);
  });

  it("forgets the session served longest ago past its capacity", () => {
    const memory = ProviderContext.makePinnedNotesMemory(2);
    memory.set("a", "1");
    memory.set("b", "2");
    memory.set("a", "3");
    memory.set("c", "4");
    assert.strictEqual(memory.get("b"), undefined);
    assert.strictEqual(memory.get("a"), "3");
    assert.strictEqual(memory.get("c"), "4");
  });
});

describe("providerTurnTextWithPinnedNotes", () => {
  it.effect("tracks the native session and records the delivery only when asked", () =>
    Effect.gen(function* () {
      const service = yield* NotesService;
      const threadId = ThreadId.make("thread-turn-memory");
      const projectId = ProjectId.make("project-turn-memory");
      const nb = yield* service.notebookForThread(threadId, projectId);
      yield* service.createNote({
        notebookId: nb.notebookId,
        title: "Deploy rules",
        body: "ask before prod",
        author: { _tag: "user" },
        pinned: true,
      });
      const memory = ProviderContext.makePinnedNotesMemory();
      const input = { text: "Continue", threadId, projectId, nativeThreadId: "native-1", memory };
      const first = yield* ProviderContext.providerTurnTextWithPinnedNotes(input);
      assert.include(first.text, "ask before prod");
      const repeated = yield* ProviderContext.providerTurnTextWithPinnedNotes(input);
      assert.include(repeated.text, "ask before prod");
      yield* first.delivered;
      const second = yield* ProviderContext.providerTurnTextWithPinnedNotes(input);
      assert.isTrue(second.text.startsWith('Continue\n\n<t3_notes version="1" '));
      assert.include(second.text, 'unchanged="true"');
      assert.notInclude(second.text, "ask before prod");
      // A failing store leaves the text plain and the memory untouched.
      const failing = Layer.mock(NotesService)({
        notebookForThread: () => Effect.fail(new NotesSqlError({ operation: "notebookForThread" })),
      });
      const skipped = yield* ProviderContext.providerTurnTextWithPinnedNotes(input).pipe(
        Effect.provide(failing),
      );
      assert.strictEqual(skipped.text, "Continue");
      yield* skipped.delivered;
      assert.include(
        (yield* ProviderContext.providerTurnTextWithPinnedNotes(input)).text,
        'unchanged="true"',
      );
    }).pipe(Effect.provide(LiveLayer)),
  );
});
