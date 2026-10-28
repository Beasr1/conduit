import { createContext, useContext } from "react";
import { createStore, type StoreApi, useStore } from "zustand";

import type { components } from "@/gen/schema";

type Definition = components["schemas"]["Definition"];

// The open editor's state. Selection and the open panel join the draft once
// the canvas can edit.
export interface EditorState {
  draft: Definition;
}

export type EditorStore = StoreApi<EditorState>;

// createEditorStore makes the store for one open editor, seeded once with the
// definition it opened. The saved revision stays in the query cache, so a
// refetch of it never reaches the draft.
export function createEditorStore(draft: Definition): EditorStore {
  return createStore<EditorState>()(() => ({ draft }));
}

export const EditorContext = createContext<EditorStore | null>(null);

// useEditor reads one slice of the open editor's state, so a component
// re-renders only when that slice changes.
export function useEditor<T>(selector: (state: EditorState) => T): T {
  const store = useContext(EditorContext);
  if (!store) throw new Error("useEditor needs an editor around it");
  return useStore(store, selector);
}
