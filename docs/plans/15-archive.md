# 15. Archive, never delete

Accepted 2026-11-06, with your two answers of that day in it; built
2026-11-07, and checked 2026-11-12. The queue's item 2.

## Goal

Nothing you make is deleted. A workflow, an upstream or a constant you're
done with is archived: nothing uses it any more, it's listed under
Archived, read-only, with when it was archived, and Restore brings it back.
Keys are revoked, as now, and never deleted.

## What's wrong today

- Delete erases an upstream (`server/internal/store/upstreams.go:154`) or a
  constant (`server/internal/store/constants.go:259`) for good, and only one
  nothing saved ever used. So a used one can never be retired, and a
  deleted one leaves no trace.
- A workflow can't be retired at all. Every one stays in the list, test
  and walk ones too, and its URL keeps answering its keys.

## What others do

- **GitHub** archives a repository "to make it read-only for all users and
  indicate that it's no longer actively maintained", and "You can also
  unarchive repositories that have been archived" ✓. "To make changes in an
  archived repository, you must unarchive the repository first" ✓.
- **Stripe** archives a price instead of deleting it: `active` is "Whether
  the price can be used for new purchases" ✓, so what already uses it goes
  on. GitHub and Stripe both archive what's still in use; Conduit is
  stricter, by your call below.
- **Secret managers** keep a step you can undo apart from one you can't.
  Vault "uses soft deletes to make data inaccessible while allowing data
  recovery", and a permanent delete "purges the underlying version data" ✓.
  Google: "Destroying a secret version is a permanent action", so "try
  disabling it first" ✓. AWS makes a deleted secret inaccessible at once,
  and recoverable for "a minimum of seven days" ✓.
- **Against:** "Soft Deletion Probably Isn't Worth It" (2022): "soft
  deletion logic bleeds out into all parts of your code", and "foreign keys
  are effectively lost" ✓. That's about rows meant to be gone, and hidden.
  An archived thing here is a state you see, as a revoked key is, so a run
  or a revision that refers to one still means something. The bleed is
  real: the steps name each place that has to know, each with a test.
- **GDPR's storage limitation**, Art. 5(1)(e): personal data "kept in a form
  which permits identification of data subjects for no longer than is
  necessary" ✓. A secret kept sealed once it's archived doesn't fit that
  when it's personal data, so destroying a value is on the list.

## Decided with you (2026-11-06)

- **Only what nothing live uses is archived.** Archive is refused while a
  workflow's latest or published revision, or an upstream's latest version,
  uses it, and the refusal names them, as Delete's does now. Archived means
  retired: nothing runs on it. Archiving anything, what uses it going on,
  is Stripe's way, and was the other option.
- **An archived secret constant keeps its sealed value**, so Restore brings
  it back as it was. Destroying a value for good, keeping its record, is an
  action of its own, for later (the README's queue).
- From the queue (2026-11-05): everything, workflows, upstreams and
  constants; the Delete buttons become Archive.

## How it works

1. **Archive takes a workflow, an upstream or a constant out of use.** It's
   refused while something live uses it: the latest or published revision
   of a workflow not archived, or the latest version of an upstream not
   archived, directly or through what they pin. A workflow that calls
   another at revision 3 uses what revision 3 uses, so archiving an
   upstream that only revision 3 pins is refused, naming the caller.
2. **Archived is read-only.** It can't be saved, published, run or changed,
   only looked at: a workflow's canvas, steps, revisions and runs; an
   upstream's versions; a constant's name, kind and when it changed.
3. **Using something archived is a problem**, as using something that
   doesn't exist is now: `archived_upstream`, `archived_workflow`,
   `archived_constant`. A draft can still be saved with one, showing the
   problem, but a revision that reaches one can't be run or published.
   Pickers don't offer archived things.
4. **Archiving a workflow revokes its keys** (plan 07), so its URL stops
   answering at once. Its runs stay, as every run does.
5. **Restore brings it back as it was**, under its own name; a workflow
   without keys, so new ones are made. Restore is never refused: if what it
   uses is archived too, its problems say so.
6. **Lists show what's in use**, and an Archived tab beside each the rest,
   with when each was archived. The API lists the same way: what's in use,
   or with `?archived=true` what's archived.
7. **Through the API**: `POST …/archive` and `POST …/restore` on
   `/v1/workflows/{id}`, `/v1/upstreams/{id}` and `/v1/constants/{name}`.
   The two `DELETE`s go.

## Decided while drafting, yours to overrule

- **Restore exists**, as at GitHub, Stripe and the three secret managers.
  Without it, an archive done by mistake would stay for good.
- **Names stay taken while archived**: a slug, an upstream's name, a
  constant's. A caller still calling `/serve/old-slug` must never reach a
  different workflow made later under it. GitHub says the same of a
  renamed repository: "do not reuse the original name", or "redirects to
  the renamed repository will no longer work" ✓. Making one with an
  archived name says so: restore it, or pick another. The tables already
  work this way: slugs and names are unique, archived or not.
- **An archived workflow opens in the editor read-only**: nothing on its
  canvas moves, nothing in its panels changes, and Restore stands where
  Save, Publish and Run were. React Flow's own switches fix the canvas,
  and a disabled `<fieldset>` around a panel's fields, not its tabs,
  disables every control in it at once; phase B checks that this holds
  for every Base UI part. An archived upstream's page is read-only the same
  way.
- **When, and by what**: archiving keeps its time and a provenance, as a
  save does (`actor` "token", and the client); Restore clears both. So an
  archive later undone isn't kept, until the changes list (queue item 3)
  keeps every event. A log of archives now would be a second history, to
  merge into that one later.
- **Archive and Restore change nothing when there's nothing to change**:
  archiving what's archived, or restoring what isn't, as revoking a revoked
  key does.
- **An archived secret is still masked** in what runs keep and answer: the
  masker reads every secret, archived or not, so a run that meets one's
  value doesn't keep it. An expression reads constants only by name, so
  nothing reads an archived one, and the runner doesn't change.
- **Archive and Publish take one lock**, so a publish can't put live,
  between its check and its save, a revision that uses what an archive is
  taking out of use at that moment. Nothing else needs it: a draft may use
  archived things, and a run that started first reads only pinned
  versions, which stay.
- **Used by shows what Archive checks**: latest and published revisions,
  through what they pin, so Archive is never refused for a reason its page
  doesn't show.
- **Sessions are still deleted when they end**: they're sign-ins, not
  something you made. A history of sign-ins comes with accounts.
- **Archive asks again**, in a dialog that says what happens, as Revoke
  does: for an upstream on its page and for a constant in its row, where
  Delete was, and for a workflow in the editor's header, apart from Save
  and Publish.

## Steps

- [x] **A. The store and the API**, tests first. The migration:
  `archived_at` and `archived_by` on `workflows`, `upstreams` and
  `constants`. Archive and Restore for each; what live things reach, as one
  query through what they pin. Lists of what's in use, or archived.
  `409 archived` on every change to something archived: a draft, Publish, a
  run, a key; an upstream's version; a constant's value and Undo. The three
  `archived_*` problems. Archiving a workflow revokes its keys. The lock.
  The `DELETE`s and their store functions go.
- [x] **B. The editor.** Archived tabs on Workflows, Upstreams and
  Constants; Archive, asked again, where Delete was and in the editor's
  header; an archived workflow, and an archived upstream's page, read-only
  with Restore; Used by as Archive checks it.
- [x] **C. The rest.** The browser test, the Delete test in
  `web/e2e/upstreams.spec.ts:381` becoming one that archives and restores
  one of each kind, and is refused once; mutation checks; docs (this plan,
  the README, CLAUDE.md, web.md, sources.md); a walk in Chromium through
  nginx, light and dark, desktop and phone, with PNGs.

## Done means

- Nothing is deleted through the API or the editor: a workflow, an upstream
  or a constant is archived and restored, and a key is revoked.
- Archiving what something live uses is refused, naming what uses it.
- An archived workflow's URL stops answering, and nothing archived can be
  changed or newly used.
- Restore brings each back as it was, a workflow without keys.
- `just check` is green.

## Built (2026-11-07, checked 2026-11-12)

As planned, but for these, each found while building it:

- **Publish's check moved into the store.** With one lock and the check
  left in `httpapi`, a publish would hold a connection for the lock and ask
  the pool for more to read what the revision uses. Enough publishes at
  once, each waiting on the lock, would hold every connection, and the one
  with the lock would wait for a connection none could free. So
  `store.Publish` takes a `check`, given the revision and what it uses, all
  read on its one connection (`server/internal/store/workflows.go`), and
  `problemsIn` is that check.
- **One refusal, `in_use`.** `upstream_in_use` and `constant_in_use` went
  with the `DELETE`s that answered them, and `InUseError` is one type.
- **A key waits for an archive.** Without it, a key made while its workflow
  was being archived would come after the archive revoked the rest, and
  work on an archived workflow. `CreateKey` and `RotateKey` share the
  workflow's row with `notArchived`, so they wait, and are refused.
- **Used by lists revisions, not workflows.** A workflow whose latest and
  published revisions both use something shows on two lines, `· v3` and
  `· v2 · served`. By name, as a refusal reads, which is made from the same
  rows, so it can't say what Used by doesn't.
- **A tab is a `div`, for one fieldset.** The plan had a fieldset around
  each panel's fields, not its tabs, which would have been one per tab
  panel. A `button` in a disabled fieldset is disabled; Base UI renders a tab
  as a `div` with `nativeButton={false}`, so `Fields` goes once around a
  panel. Keyboard and screen reader are as they were: `just e2e` and the
  tests of its keys passed unchanged.
- **Phase B's check of every Base UI part**, in Chromium with forced clicks,
  where jsdom can't tell, as a script's click reaches a disabled button: an
  input, a textarea, a button and a select are stopped by the fieldset, and
  the select doesn't open. **A checkbox isn't**: Base UI's is a span. Its
  hidden input is disabled, so a click does nothing, but it still takes
  focus and says nothing to a screen reader, so `Checkbox` reads `ReadOnly`
  and is disabled itself. A hint's ⓘ is a button, so hints go quiet in a
  read-only panel; left so, as what a field is for is for whoever's
  changing it.
- **Archive waits for what's unsaved**, off while there's a draft to save,
  which it would strand.
- **Archive leaves the page open**, read-only, where Delete went back to the
  list: it shows what happened, and Restore is one click away.
- **Add step, Remove connection and Tour leave a read-only editor**, and a
  drag on a step pans the canvas, as a drag on nothing does.
- **A read-only field keeps its text at full strength.** The walk showed
  Tailwind's `disabled:` halving it, which made an archived workflow hard
  to read; `index.css` puts it back for fields in a read-only fieldset,
  and leaves its buttons dimmed, as they're off.
- **An archived upstream nothing uses says "No workflow uses it."**, with no
  "yet".

Limits, known:

- What a definition reads is found by matching its text, `$const.name`, as
  before. Every read that can run is written so: anything else, `$const .x`
  or `$lookup($const, …)`, is the problem `whole_constants`. But it matches
  inside a string too. For Archive that only errs towards keeping one. A
  pinned revision with the words `$const.old` in a string, with `old`
  archived, is refused Publish for a read it doesn't make, the problem
  naming it.
- A refusal through a pin names the caller, not the path: "Orders at
  revision 5", and not "through Billing at revision 3". A step in Orders
  shows Billing's name, and is offered its newer revision. Say if the path
  is worth a field.

Checks: 91 mutations, all caught, 53 of the server's and 38 of the web's.
Six survived a first run, each closed with a test. On the server, a
version beside the one a revision pins was counted as pinned. On the web:
the archive dialog kept a refusal after it closed; both lists shared one
query key, so the Archived tab could flash what's in use; an open Keys panel
wasn't asked again after an archive; and the archived list showed when a
workflow was made.

Walked 2026-11-12 in Chromium through nginx (`just up`), light and dark,
desktop and phone:
- a refusal naming the workflow and the upstream;
- an archived workflow, read-only, with its Keys;
- an archived upstream's page;
- each Archived tab.

No list scrolls sideways at 320 or 390 px, and the console shows only the
refused archive's 409. On a phone, a table's last column, Restore or
Archive, is reached by scrolling the table, as each list's buttons already
were. Picking a step at phone width is the open side panel's, plan 05's.

## Open questions

None that block it. Destroying a secret's value waits on the README's
list.

## Sources

Read 2026-11-06 ✓.

- GitHub, archiving repositories:
  https://docs.github.com/en/repositories/archiving-a-github-repository/archiving-repositories
- GitHub, renaming a repository:
  https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository
- Stripe, update a price: https://docs.stripe.com/api/prices/update
- Vault, KV v2: https://developer.hashicorp.com/vault/docs/secrets/kv/kv-v2
- Google Secret Manager, destroy a secret version:
  https://docs.cloud.google.com/secret-manager/docs/destroy-secret-version
- AWS Secrets Manager, delete a secret:
  https://docs.aws.amazon.com/secretsmanager/latest/userguide/manage_delete-secret.html
- Soft Deletion Probably Isn't Worth It (2022):
  https://brandur.org/soft-deletion
- GDPR, Art. 5: https://gdpr-info.eu/art-5-gdpr/
