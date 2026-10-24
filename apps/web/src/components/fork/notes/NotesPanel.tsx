import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  NOTE_BODY_MAX_LENGTH,
  NOTE_TITLE_MAX_LENGTH,
  NOTEBOOK_TITLE_MAX_LENGTH,
  type Note,
  type NoteId,
  type NotebookId,
  type NotePatch,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Link2, NotebookPen, Pencil, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { RelativeTime } from "~/components/RelativeTime";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import * as notesState from "~/state/fork/notes";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

export function NotesPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId | null;
}) {
  if (props.projectId === null) {
    return (
      <NotesEmptyState
        title="Notes need a project"
        description="Open this thread inside a project to keep notebook entries."
      />
    );
  }
  return (
    <ProjectNotesPanel
      environmentId={props.environmentId}
      threadRef={props.threadRef}
      projectId={props.projectId}
    />
  );
}

function NotesEmptyState({ title, description }: { title: string; description: string }) {
  return (
    <Empty className="scrollbar-gutter-both min-h-0 justify-center-safe overflow-y-auto [&>*]:shrink-0">
      <EmptyMedia variant="icon">
        <NotebookPen className="size-4.5 text-muted-foreground" />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

const sortNotes = (notes: ReadonlyArray<Note>): ReadonlyArray<Note> =>
  notes.toSorted((left, right) =>
    left.pinned === right.pinned
      ? right.updatedAt.localeCompare(left.updatedAt)
      : left.pinned
        ? -1
        : 1,
  );

function ProjectNotesPanel({
  environmentId,
  threadRef,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
}) {
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const threadNotebook = useEnvironmentQuery(
    notesState.notebookForThread({
      environmentId,
      input: { threadId: threadRef.threadId, projectId },
    }),
  );
  const notebooks = useEnvironmentQuery(
    notesState.notebooksForProject({ environmentId, input: { projectId } }),
  );
  const [selectedNotebookId, setSelectedNotebookId] = useState<NotebookId | null>(null);
  const threadNotebookId = threadNotebook.data?.notebookId ?? null;
  const activeNotebookId = selectedNotebookId ?? threadNotebookId;
  const notes = useEnvironmentQuery(
    activeNotebookId === null
      ? null
      : notesState.notesForNotebook({ environmentId, input: { notebookId: activeNotebookId } }),
  );
  const createNotebook = useAtomCommand(notesState.createNotebook, { reportFailure: true });
  const linkThread = useAtomCommand(notesState.linkThread, { reportFailure: true });
  const createNote = useAtomCommand(notesState.createNote, { reportFailure: true });
  const updateNote = useAtomCommand(notesState.updateNote, { reportFailure: true });
  const deleteNote = useAtomCommand(notesState.deleteNote, { reportFailure: true });
  const [newNotebookTitle, setNewNotebookTitle] = useState<string | null>(null);

  const knownNotebooks = notebooks.data ?? [];
  const notebookOptions =
    threadNotebook.data !== null &&
    !knownNotebooks.some((notebook) => notebook.notebookId === threadNotebook.data?.notebookId)
      ? [...knownNotebooks, threadNotebook.data]
      : knownNotebooks;
  const notebookItems = notebookOptions.map((notebook) => ({
    value: notebook.notebookId,
    label: notebook.isDefault ? `${notebook.title} (default)` : notebook.title,
  }));
  const sortedNotes = sortNotes(notes.data ?? []);
  const canWrite = canOperate && activeNotebookId !== null;

  const submitNewNotebook = async () => {
    const title = newNotebookTitle?.trim() ?? "";
    if (title.length === 0) return;
    const result = await createNotebook({ environmentId, input: { projectId, title } });
    if (result._tag === "Success") {
      notebooks.refresh();
      setSelectedNotebookId(result.value.notebookId);
      setNewNotebookTitle(null);
    }
  };
  const linkActiveNotebook = async () => {
    if (activeNotebookId === null) return;
    const result = await linkThread({
      environmentId,
      input: { threadId: threadRef.threadId, notebookId: activeNotebookId },
    });
    if (result._tag === "Success") threadNotebook.refresh();
  };
  const submitNote = async (title: string, body: string): Promise<boolean> => {
    if (activeNotebookId === null) return false;
    const result = await createNote({
      environmentId,
      input: { notebookId: activeNotebookId, title, body, author: { _tag: "user" } },
    });
    if (result._tag === "Success") notes.refresh();
    return result._tag === "Success";
  };
  const patchNote = async (noteId: NoteId, patch: NotePatch): Promise<boolean> => {
    const result = await updateNote({ environmentId, input: { noteId, patch } });
    if (result._tag === "Success") notes.refresh();
    return result._tag === "Success";
  };
  const removeNote = async (noteId: NoteId) => {
    const result = await deleteNote({ environmentId, input: { noteId } });
    if (result._tag === "Success") notes.refresh();
  };

  const showLinkButton =
    activeNotebookId !== null && threadNotebookId !== null && activeNotebookId !== threadNotebookId;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-border border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Select
            value={activeNotebookId}
            onValueChange={(value) => {
              if (value) setSelectedNotebookId(value);
            }}
            items={notebookItems}
          >
            <SelectTrigger size="sm" aria-label="Notebook" className="min-w-0 flex-1">
              <NotebookPen className="size-3.5 shrink-0 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {notebookItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="New notebook"
            disabled={!canOperate}
            onClick={() => setNewNotebookTitle((current) => (current === null ? "" : null))}
          >
            <Plus />
          </Button>
        </div>
        {showLinkButton ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!canOperate}
            onClick={() => void linkActiveNotebook()}
          >
            <Link2 />
            Use this notebook for the thread
          </Button>
        ) : null}
        {newNotebookTitle !== null ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submitNewNotebook();
            }}
          >
            <Input
              size="sm"
              autoFocus
              placeholder="Notebook title"
              maxLength={NOTEBOOK_TITLE_MAX_LENGTH}
              value={newNotebookTitle}
              onChange={(event) => setNewNotebookTitle(event.target.value)}
            />
            <Button
              type="submit"
              size="xs"
              disabled={!canOperate || newNotebookTitle.trim().length === 0}
            >
              Create
            </Button>
          </form>
        ) : null}
        {(notebooks.error ?? threadNotebook.error) ? (
          <p className="text-destructive text-xs">{notebooks.error ?? threadNotebook.error}</p>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {notes.data === null && notes.isPending ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : notes.error !== null ? (
          <p className="px-3 py-4 text-destructive text-xs">{notes.error}</p>
        ) : activeNotebookId === null ? (
          <NotesEmptyState
            title="No notebook yet"
            description="Pick or create a notebook to start writing notes."
          />
        ) : sortedNotes.length === 0 ? (
          <NotesEmptyState
            title="No notes yet"
            description="Notes you or the agent write for this notebook show up here."
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {sortedNotes.map((note) => (
              <NoteRow
                key={note.noteId}
                note={note}
                canOperate={canOperate}
                onPatch={patchNote}
                onDelete={removeNote}
              />
            ))}
          </ul>
        )}
      </ScrollArea>
      <NoteComposer disabled={!canWrite} onSubmit={submitNote} />
    </div>
  );
}

function NoteComposer({
  disabled,
  onSubmit,
}: {
  readonly disabled: boolean;
  readonly onSubmit: (title: string, body: string) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const canSubmit = !disabled && !busy && title.trim().length > 0;
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    const ok = await onSubmit(title.trim(), body);
    setBusy(false);
    if (ok) {
      setTitle("");
      setBody("");
    }
  };
  return (
    <form
      className="flex shrink-0 flex-col gap-2 border-border border-t px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input
        size="sm"
        placeholder="Note title"
        maxLength={NOTE_TITLE_MAX_LENGTH}
        value={title}
        disabled={disabled}
        onChange={(event) => setTitle(event.target.value)}
      />
      <Textarea
        size="sm"
        placeholder="Write a note for this thread"
        maxLength={NOTE_BODY_MAX_LENGTH}
        value={body}
        disabled={disabled}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex justify-end">
        <Button type="submit" size="xs" disabled={!canSubmit}>
          {busy ? <Spinner className="size-3" /> : <Plus />}
          Add note
        </Button>
      </div>
    </form>
  );
}

function NoteRow({
  note,
  canOperate,
  onPatch,
  onDelete,
}: {
  readonly note: Note;
  readonly canOperate: boolean;
  readonly onPatch: (noteId: NoteId, patch: NotePatch) => Promise<boolean>;
  readonly onDelete: (noteId: NoteId) => Promise<void>;
}) {
  const [draft, setDraft] = useState<{ title: string; body: string } | null>(null);
  const authorLabel = note.author._tag === "thread" ? "agent" : "you";
  const saveDraft = async () => {
    if (draft === null || draft.title.trim().length === 0) return;
    const ok = await onPatch(note.noteId, { title: draft.title.trim(), body: draft.body });
    if (ok) setDraft(null);
  };
  return (
    <li className={cn("flex flex-col gap-1.5 px-3 py-2.5", note.pinned && "bg-accent/30")}>
      {draft !== null ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void saveDraft();
          }}
        >
          <Input
            size="sm"
            autoFocus
            maxLength={NOTE_TITLE_MAX_LENGTH}
            value={draft.title}
            onChange={(event) => setDraft({ title: event.target.value, body: draft.body })}
          />
          <Textarea
            size="sm"
            maxLength={NOTE_BODY_MAX_LENGTH}
            value={draft.body}
            onChange={(event) => setDraft({ title: draft.title, body: event.target.value })}
          />
          <div className="flex justify-end gap-1.5">
            <Button type="button" size="xs" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button type="submit" size="xs" disabled={draft.title.trim().length === 0}>
              Save
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 truncate font-medium text-sm">{note.title}</span>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                size="icon-micro"
                variant="ghost"
                aria-label={note.pinned ? "Unpin note" : "Pin note"}
                disabled={!canOperate}
                onClick={() => void onPatch(note.noteId, { pinned: !note.pinned })}
              >
                {note.pinned ? <PinOff /> : <Pin />}
              </Button>
              <Button
                size="icon-micro"
                variant="ghost"
                aria-label="Edit note"
                disabled={!canOperate}
                onClick={() => setDraft({ title: note.title, body: note.body })}
              >
                <Pencil />
              </Button>
              <Button
                size="icon-micro"
                variant="ghost-destructive"
                aria-label="Delete note"
                disabled={!canOperate}
                onClick={() => void onDelete(note.noteId)}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
          {note.body.length > 0 ? (
            <p className="line-clamp-6 whitespace-pre-wrap text-muted-foreground text-xs">
              {note.body}
            </p>
          ) : null}
          <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <span>{authorLabel}</span>
            <span aria-hidden="true">{"·"}</span>
            <RelativeTime timestamp={note.updatedAt} />
          </div>
        </>
      )}
    </li>
  );
}
