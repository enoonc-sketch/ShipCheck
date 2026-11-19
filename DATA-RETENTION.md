# ShipCheck — Data Retention

All data lives in Forge Storage on your Atlassian Cloud site. ShipCheck
runs no server of its own, so there is no separate copy anywhere else.
Forge Storage values are capped at 240 KiB each (official Forge docs);
ShipCheck keeps every value far below that by construction (see below).

## What is kept, for how long

| Item | Storage key | Kept until |
|---|---|---|
| Settings (configs, weights, switches, digest day) | `shipcheck:settings` | Until the admin changes or the app is uninstalled |
| CoArena API key | `shipcheck:secrets:coarena` | Until removed in Settings or the app is uninstalled |
| Bitbucket API token | `shipcheck:secrets:bitbucket` | Until removed in Settings or the app is uninstalled |
| Score snapshots, per version (last 5 each) | `shipcheck:history:<version>` | Until the version's 6th snapshot pushes the oldest out, or the app is uninstalled |
| Score-history index (one entry per version, max 200) | `shipcheck:history:index` | Until the 201st version pushes the oldest out, or the app is uninstalled |
| Published release-notes page id, per version | `published-<version>` | Until the page is deleted in Confluence (the next dashboard load clears the stale marker) or the app is uninstalled |
| Last digest, per release | `shipcheck:last-digest:<project>:<version>` | Overwritten by the next digest for that release, or the app is uninstalled |
| Last digest sent timestamp, per release | `shipcheck:last-digest-sent:<project>:<version>` | Overwritten by the next sent digest, or the app is uninstalled |
| Digest run status, per release | `shipcheck:last-digest-status` | Overwritten by the next digest run, or the app is uninstalled |
| Push-comment dedup markers, per release per day | `shipcheck:pushed:<version>:<YYYY-MM-DD>` | They are only read for the current day; old ones are never read again and disappear with the app |
| Audit events (last 100 admin operations) | `shipcheck:audit:events` | Until the 101st event pushes the oldest out, or the app is uninstalled |
| Jira context cache | `shipcheck:cache:jira:<project>:<version>` | 5 minutes (TTL), then ignored and overwritten on the next fetch |
| Bitbucket cache | `shipcheck:cache:bb:<workspace>:<repo>` | 10 minutes (TTL), then ignored and overwritten on the next fetch |

Legacy keys from 0.6.0 (`shipcheck:score-history`,
`shipcheck:last-digest`, `shipcheck:last-digest-sent`) are migrated
into the per-version layout on first use after the 0.7.0 upgrade and
then deleted.

## Deletion

- **One secret:** clear it in ShipCheck Settings (Remove key / Remove
  token) — the storage key is deleted immediately.
- **One version's history:** there is no UI for this in 0.7.0; it ages
  out automatically (5 snapshots per version, 200 versions in the
  index).
- **Everything:** uninstalling the app removes its Forge Storage.
  (Forge deletes app storage on uninstall; Confluence pages created by
  the app — release notes, digests — are ordinary pages on your site
  and must be deleted in Confluence if you want them gone.)

## What is never stored

- The AI summary prompt and response (generated on demand, shown once,
  not stored).
- Secrets in the audit log: audit events hold only the action, the
  caller's account id, the time and the outcome — never a key, token
  or webhook URL (the audit module rejects secret-looking fields).
- Jira issue bodies, comments, or attachments.
- Bitbucket source code, diffs, or commit messages (only PR states,
  approval counts, check results and the latest pipeline result are
  held in the 10-minute cache).
- User email addresses or any credential other than the two secrets
  above.
