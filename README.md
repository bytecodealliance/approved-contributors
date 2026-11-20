# approved-contributors

A GitHub Action that permits only pull requests from contributors on an allowlist.
Closes unapproved pull requests with a configurable message, and supports a
small set of /vouch commands from maintainers to manage the allowlist.

## How it works

Each run sweeps the repository: it fetches the allowlist and blocklist,
enumerates open pull requests opened within the last 24 hours, and comments
on and closes every one whose author is neither on the list nor has write (or admin, or
maintain) access to the repository. Write access is checked with the
[collaborator permission
API](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user),
which reflects grants from teams and organization base permissions, so
maintainers never need to be listed. Pull requests older than 24 hours are
never closed, so enabling the action (or revoking/blocking someone) does not
close long-standing PRs.

An optional blocklist, in the same repository as the allowlist, names
accounts that are unwelcome to contribute. Their PRs are closed with a
separate `blocked-message`, even if they are also on the allowlist. Authors
with write access are exempt from the blocklist too.

It ignores the triggering event's payload and never checks out code, so
nothing a PR author controls can influence it. It runs on a `schedule`
(every 5 minutes, the shortest interval GitHub allows) rather than on pull
request events: `pull_request` runs get a read-only token for PRs from forks,
and GitHub holds them for first-time contributors until a maintainer
approves them.

Scheduled workflows only run from the default branch, can be delayed when
GitHub Actions is under heavy load, and are disabled in public repositories
after 60 days without repository activity. `workflow_dispatch` runs a sweep
on demand.

## Vouching

When `vouch-team` is set, members of that team can manage the lists by
commenting on a pull request:

| Comment                                 | Effect |
|-----------------------------------------|--------|
| `/vouch allow` or just `/vouch`         | Add the PR author to the allowlist, and reopen the PR if it was closed before the comment. |
| `/vouch revoke`                         | Remove the PR author from the allowlist. The next sweep closes their open PRs opened in the last 24 hours. |
| `/vouch block`                          | Add the PR author to the blocklist (requires `blocklist-path`). The next sweep closes their open PRs opened in the last 24 hours with `blocked-message`. |

Revoking means the author needs a new vouch; blocking is a stronger judgment
that the account is unwelcome. There is no command to unblock: maintainers
remove the login from the blocklist by editing it in `permissions-repo`.
Only the first line of a comment is read as the command, so the rest can
explain the decision. While an author is blocked, `/vouch allow` and `/vouch revoke` for them are
ignored.

Each change is committed to the list with the title
`<command> <author> by <maintainer>` (e.g. `allow octocat by alice`) and the
body `Via: <comment link>`. Maintainers will usually be vouching on PRs the
action already closed; that's expected.

- Only comments that start with `/vouch` are considered. Comments from people
  outside the team, and unknown subcommands, are ignored.
- Edited (or hidden) comments are ignored, because anyone with write access
  can edit someone else's comment.
- Each run re-reads comments from the last 24 hours, and only the latest
  vouch for each author counts, across all of their PRs. Re-processing is
  idempotent: no commit is made if the list already agrees, and a PR closed
  after its `/vouch allow` is not reopened.
- Hand-editing the allowlist to contradict a vouch from the last 24 hours will be
  undone by the next run; post a new vouch instead. Likewise, unblocking
  someone within 24 hours of a `/vouch block` will be undone; wait a day.

The commit is made through the contents API to `permissions-ref` (or the
default branch), so that branch must not require pull requests or status
checks for the token's identity.

## List format

Both lists use the same format: one GitHub login per line. Blank lines and `#` comments are ignored, a leading
`@` is optional, and matching is case-insensitive. Include bot accounts such
as `dependabot[bot]` if they should be allowed.

```text
# maintainers
alice
@bob  # reviewer
dependabot[bot]
```

## Usage

Copy [`examples/approved-contributors.yml`](examples/approved-contributors.yml)
into `.github/workflows/`.

| Input               | Required | Description |
|---------------------|----------|-------------|
| `permissions-repo`  | yes      | `owner/name` of the repository holding the lists. |
| `permissions-ref`   | no       | Branch, tag, or SHA to read. Defaults to the default branch. |
| `permissions-token` | no       | Token for `permissions-repo` and `vouch-team`. Defaults to `token`. |
| `allowlist-path`    | yes      | Path to the allowlist within `permissions-repo`. |
| `blocklist-path`    | no       | Path to the blocklist within `permissions-repo`. The blocklist is off when empty. |
| `vouch-team`        | no       | `org/team-slug` whose members can `/vouch`. Vouching is off when empty. |
| `message`           | yes      | Comment posted before closing. `{author}` is replaced with the PR author's login. |
| `blocked-message`   | if `blocklist-path` | Comment posted before closing a blocked author's PR. `{author}` is substituted as in `message`. |
| `token`             | no       | Token used to list, comment on, and close PRs. Defaults to `github.token`. |

Output `closed` is a JSON array of the PR numbers closed by this run.

Each run ends its log with an audit log of every write it made, one line per
action, printed even if the run fails partway:

```text
Audit log: 4 action(s) taken.
  2026-11-20T10:00:01.123Z commit file=org/gov:approved.txt sha=3f9c... message="allow newbie by maint"
  2026-11-20T10:00:01.456Z reopen pr=7 via=https://github.com/org/proj/pull/7#issuecomment-1
  2026-11-20T10:00:02.789Z comment pr=9 author=mallory url=https://github.com/org/proj/pull/9#issuecomment-2
  2026-11-20T10:00:03.012Z close pr=9 author=mallory reason=not-approved
```

`reason` is `not-approved` or `blocked`.

If the allowlist cannot be fetched or is empty, or `blocklist-path` is set
but cannot be fetched, the action fails rather than closing anything. An
empty blocklist is fine.

### Tokens

The workflow needs:

- `contents: write`: GitHub only lets tokens with push access read
  collaborator permissions, which the action uses to let authors with write
  access through. The action never pushes to this repository.
- `pull-requests: write` and `issues: write`: to close PRs and post the
  closing comment (which goes through the issues API).

`github.token` can only read the current repository and can never read
organization teams. Pass a GitHub App installation token or a fine-grained
personal access token (owned by the organization) as `permissions-token` when:

- the lists are in a different private repository: repository
  `Contents: read` on `permissions-repo`;
- `vouch-team` is set: repository `Contents: read and write` on
  `permissions-repo`, and organization `Members: read`.

## Demo

A user sees:

![A github PR where an unknown contributor opens a PR, the bot closes it, a
maintainer /vouch allows it, and the bot re-opens it](./public.png)

A member of the vouch-team sees:

![The above PR, with a commit to the contributor-permissions repo mentioned in
the stream](./maintainer.png)


## Development

```sh
npm test
```
