import type { XYPosition } from "@xyflow/react";
import { createContext, useContext } from "react";
import { createStore, type StoreApi, useStore } from "zustand";

import {
  move,
  outputToStep,
  renameNode,
  settle,
} from "@/features/editor/edits";
import {
  exitsOf,
  handlesOf,
  RESPONSE,
  toFlow,
  UNHANDLED_HANDLE,
} from "@/features/editor/flow";
import type { Called } from "@/features/editor/upstreams";
import type { components } from "@/gen/schema";

type Definition = components["schemas"]["Definition"];
type Upstream = components["schemas"]["Upstream"];
type Parameter = components["schemas"]["Parameter"];

// An upstream being edited on its page (plan 07): its request, responses
// and samples are the page's one step's in the draft, and its parameters
// these.
export interface UpstreamEdit {
  node: string;
  parameters: Parameter[];
}

interface Selection {
  nodes: string[];
  edges: string[];
}

export interface Refused {
  step: string;
}

// The open editor's state. The canvas names nodes and edges by toFlow's keys,
// which for a valid draft are the node ids themselves.
export interface EditorState {
  draft: Definition;
  // The versions of upstreams the draft's steps use, by versionKey, which
  // fill those steps (plan 07). A version never changes, so one fetched is
  // kept.
  versions: Record<string, Upstream>;
  addVersion: (key: string, version: Upstream) => void;
  // The revisions of workflows the draft's steps use, by versionKey, which
  // fill those steps (plan 07).
  called: Record<string, Called>;
  addCalled: (key: string, called: Called) => void;
  upstreamEdit: UpstreamEdit | undefined;
  editUpstream: (edit: UpstreamEdit | undefined) => void;
  // The step that a revision's output, kept from before the response, moved
  // into when it opened, so the editor can say why there are changes to
  // save. Undefined when there was nothing to move.
  moved: string | undefined;
  // Nodes being dragged, and where they are now. The draft hears about a drag
  // only when it ends, rather than on every frame of it.
  moving: Record<string, XYPosition>;
  selected: Selection;
  // The part of the one step picked that its panel opens on: "request", a
  // response by its block ("2xx", "404"), or "add", adding one. A click on
  // a block opens its part, and picking another step opens its request.
  part: string;
  setPart: (part: string) => void;
  // The tab a step's Request opens on (plan 13): "url", "headers",
  // "query", "body" or "retry". Kept across steps, so the problem list can
  // open the one a field is in.
  requestTab: string;
  setRequestTab: (tab: string) => void;
  // What the side panel shows while nothing is picked: the workflow's own
  // settings, the list of problems, or its runs. Opening one puts away what
  // was picked, and picking something closes it.
  panel: "settings" | "problems" | "runs" | undefined;
  openPanel: (panel: "settings" | "problems" | "runs") => void;
  closePanel: () => void;
  // The run the canvas shows, by its id, while it shows one. The run itself
  // is the query cache's.
  run: string | undefined;
  showRun: (id: string) => void;
  closeRun: () => void;
  // A line into the response just refused: the step it was drawn from, and
  // the answer, by its place, whose one line is from another step, or none
  // when the response has no answer to join. The card says why, until the
  // next edit, pick, drag or click on the canvas.
  refused: Refused | undefined;
  refuse: (refused: Refused | undefined) => void;
  // show picks one step, connection or the response card, as a click on the
  // canvas would, opens a step on part, its request unless told, and closes
  // the panel.
  show: (kind: keyof Selection, key: string, part?: string) => void;
  edit: (change: (draft: Definition) => Definition) => void;
  // rename changes a node's id, and the selection follows it.
  rename: (index: number, id: string) => void;
  drag: (key: string, at: XYPosition) => void;
  drop: (to: Record<string, XYPosition>) => void;
  pick: (
    kind: keyof Selection,
    changes: { id: string; selected: boolean }[],
  ) => void;
}

export type EditorStore = StoreApi<EditorState>;

// createEditorStore makes the store for one open editor, seeded once with the
// definition it opened, its output moved into a step if it has one. The
// saved revision stays in the query cache, so a refetch of it never reaches
// the draft.
export function createEditorStore(
  opened: Definition,
  versions: Record<string, Upstream> = {},
  upstreamEdit?: UpstreamEdit,
  called: Record<string, Called> = {},
): EditorStore {
  const { draft, step } = outputToStep(opened);
  return createStore<EditorState>()((set) => ({
    draft,
    versions,
    addVersion: (key, version) =>
      set((s) => ({ versions: { ...s.versions, [key]: version } })),
    called,
    addCalled: (key, c) => set((s) => ({ called: { ...s.called, [key]: c } })),
    upstreamEdit,
    editUpstream: (upstreamEdit) => set({ upstreamEdit }),
    moved: step,
    moving: {},
    selected: { nodes: [], edges: [] },
    part: "request",
    setPart: (part) => set({ part }),
    requestTab: "url",
    setRequestTab: (requestTab) => set({ requestTab }),
    panel: undefined,
    openPanel: (panel) => set({ panel, selected: { nodes: [], edges: [] } }),
    closePanel: () => set({ panel: undefined }),
    run: undefined,
    showRun: (run) => set({ run }),
    closeRun: () => set({ run: undefined }),
    refused: undefined,
    refuse: (refused) => set({ refused }),
    show: (kind, key, part = "request") =>
      set({
        panel: undefined,
        selected: {
          nodes: kind === "nodes" ? [key] : [],
          edges: kind === "edges" ? [key] : [],
        },
        part,
        refused: undefined,
      }),
    // Every edit settles the draft first, so nothing placed automatically
    // moves under the user's hands. An edit that changes nothing, such as a
    // form leaving a field as it was, leaves the draft alone, settling
    // included.
    edit: (change) =>
      set((s) => {
        const settled = settle(s.draft);
        const draft = change(settled);
        if (draft === settled) return s;
        return { draft, refused: undefined, ...kept(s, draft) };
      }),
    rename: (index, id) =>
      set((s) => {
        const settled = settle(s.draft);
        const draft = renameNode(settled, index, id);
        if (draft === settled) return s;
        const from = toFlow(settled).nodes[index]?.id;
        const to = toFlow(draft).nodes[index]?.id ?? "";
        const nodes = s.selected.nodes.map((key) => (key === from ? to : key));
        return {
          draft,
          ...kept({ ...s, selected: { ...s.selected, nodes } }, draft),
        };
      }),
    drag: (key, at) => set((s) => ({ moving: { ...s.moving, [key]: at } })),
    // A key with "#" in it is a node whose id is missing or shared. Its place
    // can't be stored by id, so the layout goes on placing it.
    drop: (to) =>
      set((s) => ({
        draft: move(
          settle(s.draft),
          Object.fromEntries(
            Object.entries(to).filter(([key]) => !key.includes("#")),
          ),
        ),
        moving: {},
      })),
    pick: (kind, changes) =>
      set((s) => {
        const on = new Set(s.selected[kind]);
        for (const c of changes) {
          if (c.selected) on.add(c.id);
          else on.delete(c.id);
        }
        const picked = changes.some((c) => c.selected);
        return {
          selected: { ...s.selected, [kind]: [...on] },
          panel: picked ? undefined : s.panel,
          part: picked ? "request" : s.part,
          refused: undefined,
        };
      }),
  }));
}

// kept is the part of a selection the draft still has: a deleted node drops
// out of it, and so does an edge whose end was renamed. The response card is
// always there. A step whose open response, or case, was removed opens on
// its first part; its Unhandled is always there too, and so are the
// Parameters of one that uses an upstream.
function kept(
  { selected, part }: Pick<EditorState, "selected" | "part">,
  draft: Definition,
): Pick<EditorState, "selected" | "part"> {
  const flow = toFlow(draft);
  const nodes = selected.nodes.filter(
    (key) => key === RESPONSE || flow.nodes.some((n) => n.id === key),
  );
  const edges = selected.edges.filter((key) =>
    flow.edges.some((e) => e.id === key),
  );
  const index = flow.nodes.find((n) => n.id === nodes[0])?.data.index;
  const node = index === undefined ? undefined : draft.nodes[index];
  const open =
    !node ||
    part === "request" ||
    part === "add" ||
    part === UNHANDLED_HANDLE ||
    (part === "with" && node.uses !== undefined) ||
    handlesOf(node).includes(part) ||
    exitsOf(node).some((e) => e.part === part)
      ? part
      : "request";
  if (
    nodes.length === selected.nodes.length &&
    edges.length === selected.edges.length
  )
    return { selected, part: open };
  return { selected: { nodes, edges }, part: open };
}

export const EditorContext = createContext<EditorStore | null>(null);

// useEditorStore gives the open editor's store itself, for reading its state
// at the moment it's needed, as a form's check does.
export function useEditorStore(): EditorStore {
  const store = useContext(EditorContext);
  if (!store) throw new Error("useEditorStore needs an editor around it");
  return store;
}

// useEditor reads one slice of the open editor's state, so a component
// re-renders only when that slice changes.
export function useEditor<T>(selector: (state: EditorState) => T): T {
  return useStore(useEditorStore(), selector);
}
