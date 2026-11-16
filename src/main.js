import { appendFileSync } from "node:fs";
import {
  appendLogin,
  contentsUrl,
  isApproved,
  nextLink,
  parseList,
  parsePair,
  parseVouch,
  removeLogin,
  renderMessage,
} from "./lib.js";

// How far back to look for /vouch comments; generous so that delayed or
// skipped scheduled runs don't miss any.
const VOUCH_LOOKBACK_MS = 24 * 60 * 60 * 1000;

function input(name, { required = false } = {}) {
  const value = (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
  if (required && !value) throw new Error(`Input required and not supplied: ${name}`);
  return value;
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

async function github(token, url, { method = "GET", body, allow404 = false } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "approved-contributors-action",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (allow404 && res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`${method} ${url} failed: ${res.status} ${res.statusText}: ${detail}`);
  }
  return res;
}

async function paginate(token, url, opts) {
  const items = [];
  while (url) {
    const res = await github(token, url, opts);
    if (!res) return null;
    items.push(...(await res.json()));
    url = nextLink(res.headers.get("link"));
  }
  return items;
}

// Effective permission, including team, org base, and enterprise grants.
// 404 means the user has no access to the repository.
async function hasWriteAccess(ctx, login) {
  const res = await github(
    ctx.token,
    `${ctx.repoUrl}/collaborators/${encodeURIComponent(login)}/permission`,
    { allow404: true },
  );
  if (!res) return false;
  const { permission } = await res.json();
  return permission === "admin" || permission === "write";
}

async function readList(ctx) {
  const res = await github(ctx.listToken, contentsUrl(ctx.apiUrl, ctx.listRepo, ctx.listPath, ctx.listRef));
  const file = await res.json();
  const text = Buffer.from(file.content, "base64").toString("utf8");
  return { text, sha: file.sha, logins: parseList(text) };
}

async function writeList(ctx, list, text, message) {
  const res = await github(ctx.listToken, contentsUrl(ctx.apiUrl, ctx.listRepo, ctx.listPath), {
    method: "PUT",
    body: {
      message,
      content: Buffer.from(text).toString("base64"),
      sha: list.sha,
      ...(ctx.listRef && { branch: ctx.listRef }),
    },
  });
  list.text = text;
  list.sha = (await res.json()).content.sha;
  list.logins = parseList(text);
}

const VOUCH_ACTIONS = { allow: "allow", revoke: "revoke", block: "revoke" };

async function reopen(ctx, number) {
  console.log(`Reopening #${number}.`);
  try {
    await github(ctx.token, `${ctx.repoUrl}/pulls/${number}`, {
      method: "PATCH",
      body: { state: "open" },
    });
  } catch (err) {
    // e.g. the head branch was deleted; don't let one PR block the sweep.
    console.log(`::warning::Could not reopen #${number}: ${err.message}`);
  }
}

// Acts on recent /vouch comments by vouch-team members. Only each PR
// author's latest vouch counts, so re-reading the same comments every run
// is idempotent. "allow" adds the author to the list and reopens PRs closed
// before the vouch; "revoke"/"block" removes the author from the list.
async function processVouches(ctx, list) {
  const [org, slug] = parsePair(ctx.vouchTeam, "vouch-team");
  const members = await paginate(
    ctx.listToken,
    `${ctx.apiUrl}/orgs/${org}/teams/${slug}/members?per_page=100`,
    { allow404: true },
  );
  if (!members) {
    throw new Error(
      `Cannot read team ${ctx.vouchTeam}: check that it exists and that ` +
        "allowlist-token has organization Members: read permission",
    );
  }
  const team = new Set(members.map((m) => m.login.toLowerCase()));

  const since = new Date(Date.now() - VOUCH_LOOKBACK_MS).toISOString();
  const comments = await paginate(
    ctx.token,
    `${ctx.repoUrl}/issues/comments?since=${encodeURIComponent(since)}&per_page=100`,
  );
  comments.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);

  const pulls = new Map();
  // Lowercased author -> { last, allows }. `allows` holds the allow vouches
  // since the author's most recent revoke.
  const byAuthor = new Map();
  for (const c of comments) {
    const command = parseVouch(c.body ?? "");
    const number = /\/pull\/(\d+)#/.exec(c.html_url)?.[1];
    if (command === null || !number) continue;

    const maintainer = c.user.login;
    if (!team.has(maintainer.toLowerCase())) {
      console.log(`Ignoring ${c.html_url}: ${maintainer} is not in ${ctx.vouchTeam}.`);
      continue;
    }
    // Anyone with write access can edit others' comments.
    if (c.updated_at !== c.created_at) {
      console.log(`Ignoring ${c.html_url}: edited comments are not trusted.`);
      continue;
    }
    const action = Object.hasOwn(VOUCH_ACTIONS, command) ? VOUCH_ACTIONS[command] : null;
    if (!action) {
      console.log(`Ignoring ${c.html_url}: unknown command "/vouch ${command}".`);
      continue;
    }

    if (!pulls.has(number)) {
      pulls.set(number, await (await github(ctx.token, `${ctx.repoUrl}/pulls/${number}`)).json());
    }
    const pr = pulls.get(number);
    const key = pr.user.login.toLowerCase();
    const state = byAuthor.get(key) ?? { allows: [] };
    if (action === "revoke") state.allows = [];
    else state.allows.push({ c, pr });
    state.last = { c, command, action, pr };
    byAuthor.set(key, state);
  }

  for (const { last, allows } of byAuthor.values()) {
    const author = last.pr.user.login;
    const listed = isApproved(list.logins, author);
    if (last.action === "revoke") {
      if (!listed) continue;
      console.log(`Removing ${author} from the allowlist (${last.c.html_url}).`);
      await writeList(
        ctx,
        list,
        removeLogin(list.text, author),
        `${last.command} ${author} by ${last.c.user.login}\n\nVia: ${last.c.html_url}`,
      );
      continue;
    }
    if (!listed) {
      console.log(`Adding ${author} to the allowlist (${last.c.html_url}).`);
      await writeList(
        ctx,
        list,
        appendLogin(list.text, author),
        `allow ${author} by ${last.c.user.login}\n\nVia: ${last.c.html_url}`,
      );
    }
    const reopened = new Set();
    for (const { c, pr } of allows) {
      if (reopened.has(pr.number)) continue;
      if (pr.state === "closed" && !pr.merged && Date.parse(pr.closed_at) < Date.parse(c.created_at)) {
        reopened.add(pr.number);
        await reopen(ctx, pr.number);
      }
    }
  }
}

async function closeUnapproved(ctx, list) {
  const writers = new Map();
  const closed = [];
  for (const pr of await paginate(ctx.token, `${ctx.repoUrl}/pulls?state=open&per_page=100`)) {
    const author = pr.user.login;
    if (isApproved(list.logins, author)) continue;
    if (!writers.has(author)) writers.set(author, await hasWriteAccess(ctx, author));
    if (writers.get(author)) continue;
    console.log(`Closing #${pr.number}: ${author} is not an approved contributor.`);
    await github(ctx.token, `${ctx.repoUrl}/issues/${pr.number}/comments`, {
      method: "POST",
      body: { body: renderMessage(ctx.message, author) },
    });
    await github(ctx.token, `${ctx.repoUrl}/pulls/${pr.number}`, {
      method: "PATCH",
      body: { state: "closed" },
    });
    closed.push(pr.number);
  }
  return closed;
}

// Deliberately ignores the triggering event's payload: every decision comes
// from the API, so nothing a PR author controls can influence this run.
async function run() {
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const token = input("token", { required: true });
  const ctx = {
    apiUrl,
    repoUrl: `${apiUrl}/repos/${process.env.GITHUB_REPOSITORY}`,
    token,
    message: input("message", { required: true }),
    listRepo: input("allowlist-repo", { required: true }),
    listPath: input("allowlist-path", { required: true }),
    listRef: input("allowlist-ref"),
    listToken: input("allowlist-token") || token,
    vouchTeam: input("vouch-team"),
  };
  parsePair(ctx.listRepo, "allowlist-repo");

  const list = await readList(ctx);
  if (list.logins.size === 0) {
    // Almost certainly a misconfiguration; refuse to close every PR.
    throw new Error(`Approved contributors list ${ctx.listRepo}:${ctx.listPath} is empty`);
  }
  if (ctx.vouchTeam) await processVouches(ctx, list);

  const closed = await closeUnapproved(ctx, list);
  console.log(closed.length ? `Closed ${closed.length} pull request(s).` : "Nothing to close.");
  setOutput("closed", JSON.stringify(closed));
}

run().catch((err) => {
  console.log(`::error::${err.message}`);
  process.exitCode = 1;
});
