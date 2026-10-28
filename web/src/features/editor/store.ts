import type { XYPosition } from "@xyflow/react";
import { createContext, useContext } from "react";
import { createStore, type StoreApi, useStore } from "zustand";

import { move, renameNode, settle } from "@/features/editor/edits";
import { toFlow } from "@/features/editor/flow";
import type { components } from "@/gen/schema";

type Definition = components["schemas"]["Definition"];

interface Selection {
  nodes: string[];
  edges: string[];
}

// The open editor's state. The canvas names nodes and edges by toFlow's keys,
// which for a valid draft are the node ids themselves.
export interface EditorState {
  draft: Definition;
  // Nodes being dragged, and where they are now. The draft hears about a drag
  // only when it ends, rather than on every frame of it.
  moving: Record<string, XYPosition>;
  selected: Selection;
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
// definition it opened. The saved revision stays in the query cache, so a
// refetch of it never reaches the draft.
export function createEditorStore(draft: Definition): EditorStore {
  return createStore<EditorState>()((set) => ({
    draft,
    moving: {},
    selected: { nodes: [], edges: [] },
    // Every edit settles the draft first, so nothing placed automatically
    // moves under the user's hands. An edit that changes nothing, such as a
    // form leaving a field as it was, leaves the draft alone, settling
    // included.
    edit: (change) =>
      set((s) => {
        const settled = settle(s.draft);
        const draft = change(settled);
        if (draft === settled) return s;
        return { draft, selected: kept(s.selected, draft) };
      }),
    rename: (index, id) =>
      set((s) => {
        const settled = settle(s.draft);
        const draft = renameNode(settled, index, id);
        if (draft === settled) return s;
        const from = toFlow(settled).nodes[index]?.id;
        const to = toFlow(draft).nodes[index]?.id ?? "";
        const nodes = s.selected.nodes.map((key) => (key === from ? to : key));
        return { draft, selected: kept({ ...s.selected, nodes }, draft) };
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
        return { selected: { ...s.selected, [kind]: [...on] } };
      }),
  }));
}

// kept is the part of a selection the draft still has: a deleted node drops
// out of it, and so does an edge whose end was renamed.
function kept(selected: Selection, draft: Definition): Selection {
  const flow = toFlow(draft);
  const nodes = selected.nodes.filter((key) =>
    flow.nodes.some((n) => n.id === key),
  );
  const edges = selected.edges.filter((key) =>
    flow.edges.some((e) => e.id === key),
  );
  if (
    nodes.length === selected.nodes.length &&
    edges.length === selected.edges.length
  )
    return selected;
  return { nodes, edges };
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
