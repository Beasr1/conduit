import { UNHANDLED } from "@/features/editor/flow";
import type { components } from "@/gen/schema";

type NodeEvent = components["schemas"]["NodeEvent"];
type NodeRun = components["schemas"]["NodeRun"];
type RunError = components["schemas"]["RunError"];
type RunSummary = components["schemas"]["RunSummary"];
type RunStatus = RunSummary["status"];
type Way = components["schemas"]["Way"];

// StepRun is how one step went in the run shown: its state, the status it
// got back, if it's an HTTP step that got one, its attempts and time, why
// it failed, and the way an Either step came by. A step is waiting while the
// run hasn't reached it, and "not run" when the run ended without it.
export interface StepRun {
  state:
    | "waiting"
    | "running"
    | "retrying"
    | "succeeded"
    | "failed"
    | "skipped"
    | "cancelled"
    | "not run";
  status?: number;
  attempts?: number;
  ms?: number;
  error?: RunError;
  came?: Way;
}

// stepRunOf is how a step went: as the server recorded it, once it has,
// else as its last event said, else as far as the run has got.
export function stepRunOf(
  recorded: NodeRun | undefined,
  last: NodeEvent | undefined,
  run: RunStatus,
): StepRun {
  if (recorded) {
    const { started_at: from, ended_at: to } = recorded;
    return {
      state: recorded.status,
      ...(recorded.response?.status === undefined
        ? {}
        : { status: recorded.response.status }),
      attempts: recorded.attempts,
      ...(from === undefined ? {} : { ms: Date.parse(to) - Date.parse(from) }),
      ...(recorded.error ? { error: recorded.error } : {}),
      ...(recorded.way ? { came: recorded.way } : {}),
    };
  }
  if (last)
    return {
      state: last.kind === "started" ? "running" : last.kind,
      ...(last.http_status === undefined ? {} : { status: last.http_status }),
      attempts: last.attempt,
      ...(last.error ? { error: last.error } : {}),
      ...(last.way ? { came: last.way } : {}),
    };
  return { state: run === "running" ? "waiting" : "not run" };
}

// The words for why a step failed, when it got no status to show.
const failures: Record<RunError["code"], string> = {
  upstream_failed: "no answer",
  timeout: "timeout",
  workflow_error: "workflow error",
  internal_error: "internal error",
  cancelled: "cancelled",
  interrupted: "interrupted",
};

// said is how a step went, in a few words: "201, 140 ms", "failed: timeout,
// after 3 attempts", "skipped", or "Unhandled: 404" when its Unhandled
// block took its failure.
export function said(run: StepRun): string {
  const ms = run.ms === undefined ? "" : `, ${run.ms} ms`;
  switch (run.state) {
    case "succeeded":
      return run.status === undefined ? `done${ms}` : `${run.status}${ms}`;
    case "failed": {
      const why =
        run.status ?? (run.error ? failures[run.error.code] : undefined);
      const tries =
        run.attempts !== undefined && run.attempts > 1
          ? `, after ${run.attempts} attempts`
          : "";
      const what = run.error?.caught ? "Unhandled" : "failed";
      return `${what}${why === undefined ? "" : `: ${why}`}${tries}`;
    }
    case "retrying":
      return `retrying, attempt ${run.attempts ?? 2}`;
    default:
      return run.state;
  }
}

// takenOf says whether a run took a line: its step answered through the
// output the line leaves on (on, absent for 2xx and a transform's one, or
// UNHANDLED), and the step it leads to ran. It's undefined until both have got that
// far. The server doesn't record which lines it took, so a line whose
// condition failed, into a step another line led on, counts as taken.
// TODO(plan 04): the engine records the lines a run took, so this needn't
// guess.
export function takenOf(
  on: number | undefined,
  from: StepRun,
  to: StepRun,
): boolean | undefined {
  if (["waiting", "running", "retrying"].includes(from.state)) return undefined;
  const way = wayOf(from);
  if (way === undefined || way !== (on ?? 0)) return false;
  if (to.state === "waiting") return undefined;
  return !["skipped", "not run"].includes(to.state);
}

// wayOf is the output a step that ended answered through: 0 for 2xx and a
// transform's one, its status, or UNHANDLED when that block took its
// failure. It's undefined when the step gave no answer.
export function wayOf(run: StepRun): number | undefined {
  if (run.state === "failed" && run.error?.caught) return UNHANDLED;
  if (run.state !== "succeeded") return undefined;
  return run.status === undefined || (run.status >= 200 && run.status <= 299)
    ? 0
    : run.status;
}

// took is a time in words: milliseconds under a second, else seconds.
export function took(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// runSaid is how a run went, in a few words: "running", "succeeded in
// 1.2 s, answered 404", "failed: …", and "; Unhandled answered 502" when
// its response's unhandled answered its failure.
export function runSaid(run: RunSummary): string {
  const ms =
    run.ended_at === undefined
      ? undefined
      : Date.parse(run.ended_at) - Date.parse(run.started_at);
  const time = ms === undefined ? "" : ` in ${took(ms)}`;
  switch (run.status) {
    case "running":
      return "running";
    case "succeeded":
      return `succeeded${time}${run.answered ? `, answered ${run.answered}` : ""}`;
    case "failed":
      return `failed${time}${run.error ? `: ${run.error.detail}` : ""}${run.answered ? `; Unhandled answered ${run.answered}` : ""}`;
    default:
      return run.status;
  }
}
