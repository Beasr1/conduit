import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";
import { Link, useNavigate } from "react-router";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { SampleInput } from "@/components/upstream-samples";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HttpStepForm } from "@/features/editor/components/http-step-form";
import { AddResponse } from "@/features/editor/components/step-output";
import { StepSample } from "@/features/editor/components/step-sample";
import { updateNode } from "@/features/editor/edits";
import {
  CheckContext,
  CheckingContext,
} from "@/features/editor/hooks/use-problems";
import { PAUSE_MS, useStill } from "@/features/editor/hooks/use-still";
import type { Check } from "@/features/editor/problems";
import {
  createEditorStore,
  EditorContext,
  useEditor,
  useEditorStore,
} from "@/features/editor/store";
import {
  fill,
  sameUpstream,
  upstreamOf,
  versionKey,
  without,
} from "@/features/editor/upstreams";
import {
  useDeleteUpstream,
  useSaveUpstream,
  useUpstreamUsers,
} from "@/features/editor/hooks/use-upstreams";
import type { components } from "@/gen/schema";
import { api, ApiError, call } from "@/lib/api";
import type { UpstreamVersion } from "@/lib/upstreams";
import { routes } from "@/router";

type Parameter = components["schemas"]["Parameter"];
type ProblemError = components["schemas"]["ProblemError"];

// The one step the page edits the upstream as. The tabs a step has edit its
// request, responses and samples, on a store of its own.
const STEP = "upstream";

// sampleOf is a parameter's sample as the value the step gives it: JSON is
// JSONata, and none is null.
const sampleOf = (p: Parameter) => JSON.stringify(p.sample ?? null);

const given = (parameters: Parameter[]) =>
  Object.fromEntries(parameters.map((p) => [p.name, sampleOf(p)]));

// No parameters, one list, so a selector that finds none gives the same.
const NONE: Parameter[] = [];

// The problems a check found with the parameters, by pointer: the tabs have
// the rest.
const ParameterProblems = createContext<ProblemError[]>([]);

// UpstreamPage edits an upstream on its own (plan 07): its parameters, each
// with a sample the preview gives it, then its request, responses and
// samples in the tabs a step has, previewed and checked as they're typed.
// Save version makes the next version; the workflows that use it are
// offered it on their steps.
export function UpstreamPage({ version }: { version: UpstreamVersion }) {
  const [store] = useState(() => {
    const uses = { upstream: version.upstream.id, version: version.version };
    const versions = { [versionKey(uses)]: version.definition };
    const parameters = version.definition.parameters ?? [];
    const draft = fill(
      { nodes: [{ id: STEP, kind: "http", uses, with: given(parameters) }] },
      versions,
    );
    return createEditorStore(draft, versions, { node: STEP, parameters });
  });
  return (
    <EditorContext value={store}>
      <Checked>
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <Header version={version} />
          <UsedBy id={version.upstream.id} />
          <Parameters />
          <Blocks />
        </div>
      </Checked>
    </EditorContext>
  );
}

// Checked checks the upstream as it stands, once still a moment, and gives
// the tabs the problems with the step's request and responses, and the
// parameters theirs.
function Checked({ children }: { children: ReactNode }) {
  const draft = useEditor((s) => s.draft);
  const parameters = useEditor((s) => s.upstreamEdit?.parameters ?? NONE);
  const still = useStill({ draft, parameters }, PAUSE_MS);
  const node = still.draft.nodes[0];
  const upstream = node ? upstreamOf(node, still.parameters) : undefined;
  const checked = useQuery({
    queryKey: ["upstream-check", upstream],
    queryFn: ({ signal }) =>
      call(
        (signal) =>
          api.POST("/v1/upstreams/validate", { body: upstream!, signal }),
        signal,
      ),
    enabled: upstream !== undefined,
    staleTime: Infinity,
    meta: { quiet: true },
  });
  const problems = checked.data?.problems;
  const check = useMemo<Check | undefined>(
    () =>
      problems && {
        of: still.draft,
        problems: problems
          .filter((p) => !p.pointer.startsWith("/parameters"))
          .map((p) => ({ ...p, pointer: `/nodes/0${p.pointer}` })),
      },
    [problems, still.draft],
  );
  const status = useMemo(
    () => ({
      checking: still.draft !== draft || checked.isFetching,
      failed: checked.isError,
    }),
    [still.draft, draft, checked.isFetching, checked.isError],
  );
  const parameterProblems = useMemo(
    () => (problems ?? []).filter((p) => p.pointer.startsWith("/parameters")),
    [problems],
  );
  return (
    <CheckContext value={check}>
      <CheckingContext value={status}>
        <ParameterProblems value={parameterProblems}>
          {children}
        </ParameterProblems>
      </CheckingContext>
    </CheckContext>
  );
}

// Header names the upstream and its version, says what's unsaved, saves
// the next version, and deletes it.
function Header({ version }: { version: UpstreamVersion }) {
  const editor = useEditorStore();
  const draft = useEditor((s) => s.draft);
  const parameters = useEditor((s) => s.upstreamEdit?.parameters ?? NONE);
  const save = useSaveUpstream();
  const node = draft.nodes[0];
  const now = node ? upstreamOf(node, parameters) : undefined;
  const dirty = now !== undefined && !sameUpstream(now, version.definition);

  async function saveVersion() {
    const s = editor.getState();
    const step = s.draft.nodes[0];
    if (!step) return;
    try {
      await save.mutateAsync({
        id: version.upstream.id,
        base: version.version,
        upstream: upstreamOf(step, s.upstreamEdit?.parameters ?? []),
      });
    } catch {
      // save.error says what went wrong
    }
  }

  const status: ReactNode[] = [];
  if (save.isPending) status.push("Saving…");
  else if (save.error instanceof ApiError && save.error.status === 412)
    status.push(
      <span className="text-destructive">
        A newer version was saved elsewhere. Reload the page to edit it.
      </span>,
    );
  else if (save.error instanceof ApiError && save.error.status === 422)
    status.push(
      <span className="text-destructive">
        Not saved: it has problems, said below.
      </span>,
    );
  else if (save.isError)
    status.push(
      <span className="text-destructive">Not saved. {save.error.message}</span>,
    );
  else if (dirty) status.push("Unsaved changes");

  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold break-words">
          {version.upstream.name}
        </h1>
        <p className="text-sm text-muted-foreground">
          Version {version.version}
          {status.map((s, i) => (
            <span key={i}> · {s}</span>
          ))}
        </p>
      </div>
      <div className="flex gap-2">
        <DeleteUpstream upstream={version.upstream} />
        <Button
          disabled={!dirty || save.isPending}
          onClick={() => void saveVersion()}
        >
          Save version {version.version + 1}
        </Button>
      </div>
    </div>
  );
}

// DeleteUpstream deletes the upstream, once asked again, and goes back to
// the library. While a saved revision pins it, the server refuses, and the
// dialog says which revisions do (plan 07).
function DeleteUpstream({
  upstream,
}: {
  upstream: UpstreamVersion["upstream"];
}) {
  const [open, setOpen] = useState(false);
  const del = useDeleteUpstream();
  const navigate = useNavigate();
  const failed = !del.isError
    ? undefined
    : del.error instanceof ApiError && del.error.problem?.detail
      ? del.error.problem.detail
      : `Not deleted. ${del.error.message}`;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) del.reset();
      }}
    >
      <DialogTrigger render={<Button variant="outline" />}>
        Delete
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {upstream.name}?</DialogTitle>
          <DialogDescription>
            It goes for good, with every version.
          </DialogDescription>
        </DialogHeader>
        {failed && <p className="text-sm text-destructive">{failed}</p>}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button
            variant="destructive"
            disabled={del.isPending || failed !== undefined}
            onClick={() =>
              del.mutate(upstream.id, {
                onSuccess: () => void navigate(routes.upstreams()),
              })
            }
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// UsedBy lists the workflows whose latest revision uses the upstream, and
// at which versions.
function UsedBy({ id }: { id: string }) {
  const users = useUpstreamUsers(id);
  if (!users.data) return null;
  const workflows = users.data.workflows;
  return (
    <section aria-label="Used by" className="flex flex-col gap-1 text-sm">
      <h2 className="font-medium">Used by</h2>
      {workflows.length === 0 ? (
        <p className="text-muted-foreground">No workflow uses it yet.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {workflows.map((w) => (
            <li key={w.workflow_id}>
              <Link
                to={routes.workflow(w.workflow_id)}
                className="underline-offset-4 hover:underline"
              >
                {w.name}
              </Link>{" "}
              <span className="text-muted-foreground">
                · {w.versions.map((v) => `v${v}`).join(", ")}
                {w.published ? " · served" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Parameters names what a step gives the upstream, each with a sample the
// preview gives it, in rows under the two columns' names. The step's values
// follow a rename.
function Parameters() {
  const parameters = useEditor((s) => s.upstreamEdit?.parameters ?? NONE);
  const editUpstream = useEditor((s) => s.editUpstream);
  const edit = useEditor((s) => s.edit);
  const problems = useContext(ParameterProblems);
  const [added, setAdded] = useState("");
  const set = (next: Parameter[]) => {
    editUpstream({ node: STEP, parameters: next });
    edit((d) => updateNode(d, 0, (n) => ({ ...n, with: given(next) })));
  };
  const taken = parameters.some((p) => p.name === added);
  const names = parameters.map((p) => p.name);
  const samples = Object.fromEntries(
    parameters.flatMap((p) =>
      p.sample === undefined ? [] : [[p.name, p.sample]],
    ),
  );
  return (
    <section aria-label="Parameters" className="flex flex-col gap-2 text-sm">
      <h2 className="font-medium">Parameters</h2>
      {parameters.length === 0 && (
        <p className="text-muted-foreground">
          None yet. Its request reads a parameter by name, as{" "}
          <span className="font-mono">{"{{ user_id }}"}</span>.
        </p>
      )}
      {parameters.length > 0 && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="flex-1">Name</span>
          <span className="w-16" />
        </div>
      )}
      {parameters.map((p, k) => (
        <ParameterRow
          key={k}
          parameter={p}
          problems={problems.filter(
            (e) =>
              e.pointer.startsWith(`/parameters/${k}/`) &&
              !e.pointer.startsWith(`/parameters/${k}/sample`),
          )}
          onChange={(next) => set(parameters.with(k, next))}
          onRemove={() => set(parameters.filter((_, j) => j !== k))}
        />
      ))}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (added === "" || taken) return;
          set([...parameters, { name: added }]);
          setAdded("");
        }}
      >
        <Input
          aria-label="Add a parameter"
          className="font-mono"
          placeholder="user_id"
          value={added}
          onChange={(e) => setAdded(e.target.value.trim())}
        />
        <Button type="submit" variant="outline" size="sm" disabled={taken}>
          Add
        </Button>
      </form>
      {/* Drawn afresh as the names change, from the samples they keep. */}
      <SampleInput
        key={names.join(" ")}
        id="upstream-page"
        parameters={names}
        samples={samples}
        onChange={(next) =>
          set(
            parameters.map((p) =>
              Object.hasOwn(next, p.name)
                ? { ...p, sample: next[p.name] }
                : without(p, ["sample"]),
            ),
          )
        }
        problems={problems
          .filter((e) => /^\/parameters\/\d+\/sample/.test(e.pointer))
          .map((e) => e.detail)}
      />
    </section>
  );
}

// ParameterRow is a parameter's name, and its problems.
function ParameterRow({
  parameter,
  problems,
  onChange,
  onRemove,
}: {
  parameter: Parameter;
  problems: ProblemError[];
  onChange: (p: Parameter) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Input
          aria-label={`Name of parameter ${parameter.name}`}
          className="flex-1 font-mono"
          value={parameter.name}
          onChange={(e) => onChange({ ...parameter, name: e.target.value })}
        />
        <Button
          variant="ghost"
          size="xs"
          className="w-16"
          aria-label={`Remove the parameter ${parameter.name}`}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
      <FieldError errors={problems.map((p) => ({ message: p.detail }))} />
    </div>
  );
}

// Blocks are the request and responses, in the tabs a step has.
function Blocks() {
  const part = useEditor((s) => s.part);
  const setPart = useEditor((s) => s.setPart);
  const statuses = useEditor(
    useShallow((s) => (s.draft.nodes[0]?.outputs ?? []).map((o) => o.status)),
  );
  return (
    <Tabs value={part} onValueChange={(value: string) => setPart(value)}>
      <TabsList aria-label="Blocks" activateOnFocus>
        <TabsTrigger value="request">Request</TabsTrigger>
        <TabsTrigger value="2xx">2xx</TabsTrigger>
        {statuses.map((status) => (
          <TabsTrigger key={status} value={String(status)}>
            {status}
          </TabsTrigger>
        ))}
        <TabsTrigger value="add" aria-label="Add a response">
          + Response
        </TabsTrigger>
      </TabsList>
      <TabsContent value="request" keepMounted>
        <HttpStepForm index={0} />
      </TabsContent>
      <TabsContent value="2xx" keepMounted>
        <StepSample index={0} />
      </TabsContent>
      {statuses.map((status) => (
        <TabsContent key={status} value={String(status)} keepMounted>
          <StepSample index={0} status={status} />
        </TabsContent>
      ))}
      <TabsContent value="add" keepMounted>
        <AddResponse index={0} taken={statuses} />
      </TabsContent>
    </Tabs>
  );
}
