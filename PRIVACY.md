# ShipCheck — Privacy Policy

ShipCheck is a Forge app that runs entirely inside your Atlassian Cloud
site. It does not run its own server, it does not track users, and it
does not send data to any analytics or advertising service.

## What ShipCheck reads

- **Jira (your site, as the app):** issues in the configured project and
  version (key, summary, status, priority, type, assignee), linked pull
  requests via Jira's development info, and project membership for the
  admin check. Read with the `read:jira-work` and `read:jira-user`
  scopes, plus `read:dev-info:jira` for the development-info lookup.
- **Confluence (your site, as the app):** the configured docs space
  (to create/update the release-notes page and the weekly digest page)
  and the published page's existence. Read/write with the granular
  `read:space:confluence`, `read:page:confluence` and
  `write:page:confluence` scopes.
- **Bitbucket Cloud (external, only when you configure it):** pull
  requests and pipeline runs for the configured repository, read with a
  read-only API token you supply. No Bitbucket account data is stored.

## What ShipCheck sends out

- **CoArena (external, only when you enable the AI summary and save a
  key):** the AI summary request contains the release version, issue
  keys, titles, statuses and priorities, pull-request states,
  deployment states, and whether release notes are published — the
  minimum the model needs to write a summary. It never contains your
  API key (that travels only in the `Authorization` header), your
  settings, or any user email address. Issue titles are user data, not
  instructions: they are escaped before being sent, and the model is
  instructed to ignore any instruction inside them. You can turn the
  AI summary off entirely in ShipCheck Settings (`AI summary` switch);
  when off, no request leaves the backend at all.
- **Bitbucket Cloud:** read-only API calls (pull requests, commit
  statuses, pipelines) for the configured repository.
- **Slack (only when you save an incoming-webhook URL in Settings):**
  when a new blocker appears, ShipCheck posts a short alert to your
  webhook containing the project key, version, verdict, score, and the
  new blockers' issue keys and summaries (at most once per day per
  version). With no webhook URL saved, nothing is sent.
- **Nothing else.** No other external service is contacted.

## What ShipCheck stores (Forge Storage, on your site)

- Settings (project/version/space configuration, digest weekday,
  scoring weights, feature switches) — no secrets inside.
- Secrets separately: the CoArena API key and the Bitbucket API token,
  each under its own storage key. They are never returned to the
  frontend — the UI only learns whether one is saved.
- Score snapshots (per version, last 5) and a per-version index, used
  for the trend line. A snapshot holds the version, score, verdict,
  timestamp and the scoring-rules version — no issue content.
- The published release-notes page id per version, the last digest per
  release, digest run status, and per-day push-comment markers.
- Audit events (last 100 admin operations: settings saves, release-notes
  publishes, AI summaries, digest runs, and denied admin attempts —
  each with the time, the caller's account id, the action and the
  outcome). No secrets are ever written to the audit log.
- Short-lived caches (Jira context 5 minutes, Bitbucket data 10
  minutes) to avoid re-fetching on every dashboard load.

See `DATA-RETENTION.md` for how long each item is kept and how to
delete it.

## Who can change settings — and who can read the audit log

Only Jira administrators. These operations check the caller's admin
status on the backend before doing anything: changing settings,
publishing release notes, generating an AI summary, running a digest
now, and reading the audit log. The admin page being visible is not
proof of admin rights.

If the check itself cannot verify (for example the permission call
fails, or the caller has no account id the backend can check), the
call is allowed and the attempt is written to the audit log; only a
clear "not an administrator" answer denies the call. This fail-open
rule exists because the settings page lives under Jira's
/settings/apps/, which Jira serves only to administrators — but the
audit log means a fail-open decision is always traceable.

Reading is different: opening the dashboard, reading blockers, the
notes preview, settings, or digest status needs no admin rights —
anyone who can open the ShipCheck panel can read them. Settings reads
never include secrets (the UI only learns whether a key is saved).

## Questions

ShipCheck is a Codegeist 2026 entry by Hailin Li. The source is in
the app's repository; the data flows above are implemented in
`src/adapters.js`, `src/bitbucket.js`, `src/ai-summary.js`,
`src/confluence.js` and `src/settings.js`.
