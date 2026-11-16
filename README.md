# approved-contributors

A GitHub Action that closes open pull requests whose authors are not on an
approved contributors list. The list is a text file stored in a GitHub
repository.

## How it works

Each run sweeps the repository: it fetches the list, enumerates all open pull
requests through the API, and comments on and closes every one whose author
is neither on the list nor has write (or admin, or maintain) access to the
repository. Write access is checked with the
[collaborator permission API](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user),
which reflects grants from teams and organization base permissions, so
maintainers never need to be listed.

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

When `vouch-team` is set, members of that team can manage the allowlist by
commenting on a pull request:

| Comment                                 | Effect |
|-----------------------------------------|--------|
| `/vouch allow`                          | Add the PR author to the allowlist, and reopen the PR if it was closed before the comment. |
| `/vouch revoke` or `/vouch block`       | Remove the PR author from the allowlist. The next sweep closes their open PRs. |

Each change is committed to the allowlist with the title
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
- Hand-editing the list to contradict a vouch from the last 24 hours will be
  undone by the next run; post a new vouch instead.

The commit is made through the contents API to `allowlist-ref` (or the
default branch), so that branch must not require pull requests or status
checks for the token's identity.

## List format

One GitHub login per line. Blank lines and `#` comments are ignored, a leading
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

| Input             | Required | Description |
|-------------------|----------|-------------|
| `allowlist-repo`  | yes      | `owner/name` of the repository holding the list. |
| `allowlist-path`  | yes      | Path to the list within that repository. |
| `allowlist-ref`   | no       | Branch, tag, or SHA to read. Defaults to the default branch. |
| `allowlist-token` | no       | Token for `allowlist-repo` and `vouch-team`. Defaults to `token`. |
| `vouch-team`      | no       | `org/team-slug` whose members can `/vouch allow`. Vouching is off when empty. |
| `message`         | yes      | Comment posted before closing. `{author}` is replaced with the PR author's login. |
| `token`           | no       | Token used to list, comment on, and close PRs. Defaults to `github.token`. |

Output `closed` is a JSON array of the PR numbers closed by this run.

If the list cannot be fetched or is empty, the action fails rather than
closing anything.

### Tokens

The workflow needs `pull-requests: write` and `issues: write` (the closing
comment goes through the issues API).

`github.token` can only read the current repository and can never read
organization teams. Pass a GitHub App installation token or a fine-grained
personal access token (owned by the organization) as `allowlist-token` when:

- the list is in a different private repository: repository `Contents: read`
  on `allowlist-repo`;
- `vouch-team` is set: repository `Contents: read and write` on
  `allowlist-repo`, and organization `Members: read`.

## Development

```sh
npm test
```
