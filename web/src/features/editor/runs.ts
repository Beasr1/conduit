import { outputOf, UNHANDLED } from "@/features/editor/flow";
import type { components } from "@/gen/schema";

type NodeEvent = components["schemas"]["NodeEvent"];
type NodeRun = components["schemas"]["NodeRun"];
type RunError = components["schemas"]["RunError"];
type RunSummary = components["schemas"]["RunSummary"];
type RunStatus = RunSummary["status"];
type Line = components["schemas"]["Line"];

// StepRun is how one step went in the run shown: its state, the status it
// got back, if it's an HTTP step that got one, its attempts and time, why
// it failed, and the lines its answer took. A step is waiting while the run
// hasn't reached it, and "not run" when the run ended without it.
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
  took?: Line[];
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
      ...(recorded.took ? { took: recorded.took } : {}),
    };
  }
  if (last)
    return {
      state: last.kind === "started" ? "running" : last.kind,
      ...(last.http_status === undefined ? {} : { status: last.http_status }),
      attempts: last.attempt,
      ...(last.error ? { error: last.error } : {}),
      ...(last.took ? { took: last.took } : {}),
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

// takenOf says whether a run took a line into an answer: its step answered
// through the output the line leaves on (on, absent for 2xx and a
// transform's one, or UNHANDLED), and the run answered with it, as to says.
// It's undefined until both have got that far.
export function takenOf(
  on: number | undefined,
  from: StepRun,
  to: StepRun,
  cases = false,
): boolean | undefined {
  if (["waiting", "running", "retrying"].includes(from.state)) return undefined;
  const way = wayOf(from, cases);
  if (way === undefined || way !== (on ?? 0)) return false;
  if (to.state === "waiting") return undefined;
  return !["skipped", "not run"].includes(to.state);
}

// tookLine says whether a run took a line into a step: once the step the
// line leaves (from) has ended, whether its answer took the line to the step
// to, leaving on on. It's undefined until then.
export function tookLine(
  on: number | undefined,
  from: StepRun,
  to: string,
): boolean | undefined {
  if (["waiting", "running", "retrying"].includes(from.state)) return undefined;
  return (from.took ?? []).some((l) => l.to === to && outputOf(l) === on);
}

// wayOf is the output a step that ended answered through: 0 for 2xx and a
// transform's one, its status, or UNHANDLED when that block took its
// failure; for a transform with cases, the status of the case that held,
// which names its exit. It's undefined when the step gave no answer.
export function wayOf(run: StepRun, cases = false): number | undefined {
  if (run.state === "failed" && run.error?.caught) return UNHANDLED;
  if (run.state !== "succeeded") return undefined;
  if (cases) return run.status;
  return run.status === undefined || (run.status >= 200 && run.status <= 299)
    ? 0
    : run.status;
}

// took is a time in words: milliseconds under a second, else seconds.
export function took(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// calledBy says where a run came from: here, a step of another workflow's
// run (plan 07), or its URL, by the caller key it was called with, which
// its first characters tell apart from the key it was rotated to.
export function calledBy(run: RunSummary): string {
  switch (run.trigger) {
    case "editor":
      return "run here";
    case "workflow":
      return "called by a step of another workflow";
    case "served":
      return run.key
        ? `called by ${run.key.name} (${run.key.prefix}…)`
        : "called at its URL";
  }
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
