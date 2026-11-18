# 16. A changes list on each workflow

Accepted 2026-11-12, with your three answers of that day in it. The queue's
item 3.

## Goal

Each workflow says what has happened to what it uses, newest first: a
constant it reads changed, a newer version of an upstream it uses, a newer
revision of a workflow it uses, a key of its own rotated. What's still to
come, or waits on you, is active. Once it's dealt with, or dismissed, it
moves to the workflow's history. History is kept for good, so nothing that
happened is lost. It also closes plan 15's gap: an archive later undone
leaves a record.

## What's wrong today

- A constant changes for every run at once (plan 06), and no workflow that
  reads it says so. The change shows only on the Constants page, and only
  until the next one replaces its previous value.
- A step is offered a newer version of its upstream, or a newer revision
  of a workflow it uses, only once someone opens that step. Nothing says
  so on the workflow.
- A rotated key's old value stops working at its expiry, and only the Keys
  panel shows it, to someone who opens it in time.
- Restore clears an archive's mark (plan 15), so an archive later undone
  leaves no trace.

## What others do

- **GitHub's notifications** have an inbox and Done: Done "Marks a
  notification as completed and removes the notification from your inbox"
  ✓. But "Notifications marked as Done are saved for 3 months" ✓.
- **Dependabot's alerts** come closest to your pick. You can "click a reason
  for dismissing the alert" ✓, and "Unfixed dismissed alerts can be reopened
  later" ✓. An alert's states are `auto_dismissed`, `dismissed`, `fixed` and
  `open` ✓, and a person can set only `dismissed` or `open` ✓: `fixed` is
  GitHub's, once the dependency is updated. Resolving itself, or
  dismissed, is the same split.
- **Stripe's events** record what happened to each resource, and you "can
  access events through the Retrieve Event API for 30 days" ✓.
- **Kubernetes** keeps events for an hour: `--event-ttl`, "Amount of time to
  retain events", default `1h0m0s` ✓.
- None of the four keeps what happened for good, and you asked for exactly
  that (2026-11-05). So history here has no expiry, as runs, revisions,
  versions and keys have none.

## Decided with you (2026-11-12)

- **It holds what happens to what the workflow uses**, recorded as it
  happens and never deleted:
  - a constant it reads, changed;
  - a newer version of an upstream it uses;
  - a newer revision of a workflow it uses;
  - a key of its own made, rotated, expiring, expired or revoked;
  - the workflow itself archived or restored.
  Its own saves and publishes aren't in it: its revisions already say
  those. The other options were those as well, or only what needs acting
  on.
- **An item leaves the active list on its own once dealt with**, as when a
  step moves to the newer version or an old key expires. **One that only
  informs** has a Dismiss. The other options were always by hand, like an
  inbox, or always on its own.

## How it works

1. **A change is recorded once, as it happens**, in the transaction that
   makes it, so neither commits without the other. It says what changed,
   when, and by what (a provenance, as a save keeps). It never holds a
   value: a constant's name and kind, not its value, secret or not.
2. **It goes on the list of each workflow it touches**, worked out then:
   - **A constant changed** (a new value, an Undo, or made secret): each
     workflow whose latest or published revision reads it, directly or
     through what it pins. That's plan 15's live set, as Archive checks it.
   - **A new version of an upstream**: each workflow whose latest or
     published revision pins an older version of it.
   - **A newly published revision of a workflow**: each workflow whose latest
     or published revision pins an older revision of it.
   - **A key rotated, made or revoked**: its own workflow.
   - **The workflow archived or restored**: itself.
3. **Active, or history**, worked out as it's read, never stored:
   - **A newer version or revision** is active while the workflow's latest
     revision still pins an older one. It leaves as soon as a save moves
     the step up, which Publish then serves.
   - **A rotated key** is active while its old value still works. It leaves
     at the expiry chosen, or once the old key is revoked. Rotated with
     "now", it's history at once.
   - **A constant changed** is active until it's dismissed.
   - **What someone did to the workflow itself** goes straight to history:
     a key made or revoked, an archive or a restore. Nothing waits on
     anyone.
   - Any active item can be dismissed. History says whether each was dealt
     with or dismissed, when, and by what.
4. **The editor shows it**: a Changes button in the canvas toolbar, beside
   Runs and Keys, with the number active, opens a panel: the active ones
   first, then the history, newest first, each in a line. A click on one
   about a step opens that step, where Use v4 is.
5. **The workflow list shows how many are active**, in a column of its own,
   so nobody has to open each workflow to find what waits.
6. **Through the API**: `GET /v1/workflows/{id}/changes`, with
   `?active=true` or `false`, paged as runs are, and `POST
   /v1/workflows/{id}/changes/{change}/dismiss`. The workflow's own record
   carries its count of active changes.

## Decided while drafting, yours to overrule

- **One record per change, and an entry for each workflow it touches.**
  Who it touched is worked out once, when it happens, and kept, so history
  says what each workflow was told then, whatever it uses now. Working it
  out on every read would be smaller, but would rewrite the past each time
  a workflow moves on.
- **Active is worked out, not stored**, from the record and how things stand.
  Nothing has to run on a clock to move an expired key's item to history,
  and nothing can forget to. The cost is that an item can come back:
  moving a step back to the older version makes its item active again.
  Dismiss deals with that.
- **An archived upstream's or constant's changes are recorded too**: its
  archive and restore, and a constant's changes of value. Nothing live uses
  either, so no workflow's list shows them. The API lists them, at `GET
  /v1/upstreams/{id}/changes` and `GET /v1/constants/{name}/changes`, which
  closes plan 15's gap for all three kinds. A history on the upstream's page
  and the constant's row is for later.
- **Dismiss is final, and has no reason.** Dependabot asks for a reason and
  lets an alert reopen. Here an item is either a version you can still move
  to, which the step offers anyway, or a notice. Say if you want either.
- **No email or push**, for now: the count in the list and the editor is
  the notification. There are no accounts yet to send anything to.
- **Only what it pins directly**: a workflow that calls Billing at
  revision 3 is told when Billing publishes revision 4. It isn't told when
  an upstream Billing uses has a new version: that's Billing's to take
  up, and it publishes once it does.

## Steps

- [x] **A. The store and the API**, tests first:
  - the migration: a table of changes and one of each workflow's entries;
  - the record and its entries written in each transaction that changes
    something, as listed above;
  - active and history worked out as they're read;
  - Dismiss, and each workflow's count;
  - the lists, for a workflow, an upstream and a constant;
  - the schema, then `just gen`.
- [x] **B. The editor**: the Changes button and its panel, a click opening
  the step, and the count on the workflow list.
- [x] **C. The rest**:
  - the browser test: a constant changed, a newer upstream version taken
    up, a key rotated "now" and one with an hour;
  - mutation checks;
  - docs (this plan, the README, CLAUDE.md, web.md, go.md, sources.md);
  - a walk in Chromium through nginx, light and dark, desktop and phone,
    with PNGs.

## Done means

- Each change to what a workflow uses is on its list, recorded as it
  happened, and none is ever deleted.
- An item leaves the active list once dealt with, or dismissed, and stays
  in history, saying which.
- An archive later undone has a record, for each kind.
- No value of a constant is ever in a change.
- `just check` is green.

## Built (2026-11-12)

As planned, but for these, each found while building it:

- **`?history=true` lists the history**, where the plan had `?active=`. A
  boolean that's absent is false, so the default, with no parameter, is
  the active list, as `?archived=true` asks for the other list of
  workflows.
- **Every change says by what**, so Restore, Revoke and Publish now take a
  provenance, as Archive and a save did. Revoke runs in a transaction, to
  record only a revocation that changes something.
- **A newer version for a workflow whose latest revision no longer uses
  the upstream is born done**: its published revision pins the older one,
  so it's told, but publishing the latest is what's left, and the editor
  says that already.
- **A workflow's own publish is recorded, on no workflow's list**: it's the
  workflows that pin it that are told.
- **The Changes button says how many are active**, from the active list
  itself, which a save, a key's change, an archive and a dismissal ask for
  again. The panel shows the first 50 of each list, as Runs does.
- **Dismiss works on an archived workflow too**: its list isn't the
  workflow, which stays as it was.

Limits, known:

- An item worked out from how things stand can come back, as the plan
  said: move a step back to the older version and it's active again.
- A rotated key's item is active while `expires_at > now()`. With `>=`
  it would be the same everywhere but the instant of the rotating
  transaction itself, so no test can tell the two apart; the mutation
  check that tries it is the one survivor.
- At phone width the Changes panel is clipped at the right edge, as every
  side panel is (plan 05's phone layout, on the README's list).

Checks: 46 mutations, 45 caught: 32 of the server's, all caught but the
expiry's `>=` above, and 14 of the web's. Two of the web's survived a
first run, each closed with a test: a save, and a key's change, didn't
ask for the changes again.

Walked 2026-11-12 in Chromium through nginx (`just up`), light and dark,
desktop and phone: the workflow list with its Changes column, and a
workflow's panel with three active changes and its history. No console
errors, and the list doesn't scroll sideways at 320 or 390 px. The walk
found one thing: a line that opens a step didn't wrap, as the kit's
Button keeps its width and one line, which pushed its Dismiss out of the
panel. It wraps now.

## Open questions

None that block it.

## Sources

Read 2026-11-12 ✓.

- GitHub, managing notifications from your inbox:
  https://docs.github.com/en/subscriptions-and-notifications/how-tos/viewing-and-triaging-notifications/managing-notifications-from-your-inbox
- GitHub, viewing and updating Dependabot alerts:
  https://docs.github.com/en/code-security/dependabot/dependabot-alerts/viewing-and-updating-dependabot-alerts
- GitHub, REST API for Dependabot alerts: https://docs.github.com/en/rest/dependabot/alerts
- Stripe, events: https://docs.stripe.com/api/events
- Kubernetes, kube-apiserver:
  https://kubernetes.io/docs/reference/command-line-tools-reference/kube-apiserver/
