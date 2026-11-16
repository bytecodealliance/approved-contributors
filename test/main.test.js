import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = new URL("../src/main.js", import.meta.url).pathname;
const json = { "Content-Type": "application/json" };
const b64 = (s) => Buffer.from(s).toString("base64");

// Runs main.js against a mock GitHub API. Returns the requests it made, plus
// the list text as last written.
//   pages:       pages of open PRs, each page a list of author logins
//   permissions: login -> repo permission (absent: 404)
//   team:        vouch-team member logins (null: team endpoint 404s)
//   comments:    issue comments returned by /issues/comments
//   pulls:       PR number -> PR object for GET /pulls/:n
async function runAction({
  pages = [[]],
  list,
  listStatus = 200,
  allowlistToken = "list-tok",
  permissions = {},
  vouchTeam = "",
  team = [],
  comments = [],
  pulls = {},
}) {
  const requests = [];
  let n = 0;
  const pageData = pages.map((p) => p.map((login) => ({ number: ++n, user: { login } })));
  let listText = list;
  let listSha = "sha0";

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const base = `http://127.0.0.1:${server.address().port}`;
      const url = new URL(req.url, base);
      const path = url.pathname;
      if (path === "/repos/org/gov/contents/approved.txt") {
        if (req.method === "PUT") {
          const put = JSON.parse(body);
          if (put.sha !== listSha) return res.writeHead(409).end("{}");
          listText = Buffer.from(put.content, "base64").toString();
          listSha = `sha${Number(listSha.slice(3)) + 1}`;
          return res.writeHead(200, json).end(JSON.stringify({ content: { sha: listSha } }));
        }
        if (listStatus !== 200) return res.writeHead(listStatus).end("{}");
        return res.writeHead(200, json).end(JSON.stringify({ content: b64(listText), sha: listSha }));
      }
      if (req.method === "GET" && path === "/repos/org/proj/pulls") {
        const page = Number(url.searchParams.get("page") ?? 1);
        const headers = { ...json };
        if (page < pageData.length) {
          headers.Link = `<${base}/repos/org/proj/pulls?state=open&per_page=100&page=${page + 1}>; rel="next"`;
        }
        return res.writeHead(200, headers).end(JSON.stringify(pageData[page - 1] ?? []));
      }
      const pull = /^\/repos\/org\/proj\/pulls\/(\d+)$/.exec(path);
      if (req.method === "GET" && pull) {
        return res.writeHead(200, json).end(JSON.stringify(pulls[pull[1]]));
      }
      if (path.startsWith("/repos/org/proj/collaborators/")) {
        const login = decodeURIComponent(path.split("/")[5]);
        if (!(login in permissions)) return res.writeHead(404).end("{}");
        return res.writeHead(200, json).end(JSON.stringify({ permission: permissions[login] }));
      }
      if (path === "/orgs/org/teams/maintainers/members") {
        if (!team) return res.writeHead(404).end("{}");
        return res.writeHead(200, json).end(JSON.stringify(team.map((login) => ({ login }))));
      }
      if (path === "/repos/org/proj/issues/comments") {
        return res.writeHead(200, json).end(JSON.stringify(comments));
      }
      res.writeHead(200, json).end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const dir = mkdtempSync(join(tmpdir(), "approved-contributors-"));
  const outputPath = join(dir, "output");
  writeFileSync(outputPath, "");

  const env = {
    PATH: process.env.PATH,
    GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
    GITHUB_REPOSITORY: "org/proj",
    GITHUB_OUTPUT: outputPath,
    "INPUT_ALLOWLIST-REPO": "org/gov",
    "INPUT_ALLOWLIST-PATH": "approved.txt",
    "INPUT_ALLOWLIST-REF": "",
    "INPUT_ALLOWLIST-TOKEN": allowlistToken ?? "",
    "INPUT_VOUCH-TEAM": vouchTeam,
    INPUT_MESSAGE: "Sorry @{author}",
    INPUT_TOKEN: "pr-tok",
  };
  const code = await new Promise((resolve) => {
    execFile(process.execPath, [MAIN], { env }, (err) => resolve(err ? err.code : 0));
  });
  server.close();
  const writes = requests
    .filter((r) => r.method !== "GET")
    .map((r) => [r.method, r.url, r.auth, JSON.parse(r.body)]);
  return { code, requests, writes, listText, output: readFileSync(outputPath, "utf8") };
}

test("closes only unapproved authors, across pages", async () => {
  const { code, requests, writes, output } = await runAction({
    pages: [["Alice", "mallory"], ["eve"]],
    list: "alice\n",
  });
  assert.equal(code, 0);
  assert.equal(requests[0].auth, "Bearer list-tok");
  assert.deepEqual(writes, [
    ["POST", "/repos/org/proj/issues/2/comments", "Bearer pr-tok", { body: "Sorry @mallory" }],
    ["PATCH", "/repos/org/proj/pulls/2", "Bearer pr-tok", { state: "closed" }],
    ["POST", "/repos/org/proj/issues/3/comments", "Bearer pr-tok", { body: "Sorry @eve" }],
    ["PATCH", "/repos/org/proj/pulls/3", "Bearer pr-tok", { state: "closed" }],
  ]);
  assert.equal(output, "closed=[2,3]\n");
});

test("authors with write access are never closed", async () => {
  const { code, requests, writes, output } = await runAction({
    pages: [["admin", "writer", "writer", "reader", "outsider"]],
    list: "alice\n",
    permissions: { admin: "admin", writer: "write", reader: "read" },
  });
  assert.equal(code, 0);
  assert.deepEqual(writes.map(([m, u]) => [m, u]), [
    ["POST", "/repos/org/proj/issues/4/comments"],
    ["PATCH", "/repos/org/proj/pulls/4"],
    ["POST", "/repos/org/proj/issues/5/comments"],
    ["PATCH", "/repos/org/proj/pulls/5"],
  ]);
  // One permission lookup per distinct author.
  assert.equal(requests.filter((r) => r.url.includes("/collaborators/")).length, 4);
  assert.equal(output, "closed=[4,5]\n");
});

test("listed authors skip the permission lookup", async () => {
  const { requests } = await runAction({ pages: [["alice"]], list: "alice\n" });
  assert.ok(!requests.some((r) => r.url.includes("/collaborators/")));
});

test("all approved: nothing closed", async () => {
  const { code, writes, output } = await runAction({ pages: [["alice"]], list: "alice\n" });
  assert.equal(code, 0);
  assert.deepEqual(writes, []);
  assert.equal(output, "closed=[]\n");
});

test("allowlist token defaults to token input", async () => {
  const { requests } = await runAction({ list: "alice\n", allowlistToken: null });
  assert.equal(requests[0].auth, "Bearer pr-tok");
});

test("list fetch failure: fails without closing", async () => {
  const { code, requests } = await runAction({ pages: [["mallory"]], list: "", listStatus: 404 });
  assert.equal(code, 1);
  assert.equal(requests.length, 1);
});

test("empty list: fails without closing", async () => {
  const { code, requests } = await runAction({ pages: [["mallory"]], list: "# nobody\n" });
  assert.equal(code, 1);
  assert.equal(requests.length, 1);
});

const T0 = "2026-11-16T10:00:00Z";
const T1 = "2026-11-16T10:05:00Z";
const comment = (id, login, body, number = 7, extra = {}) => ({
  id,
  body,
  user: { login },
  created_at: T1,
  updated_at: T1,
  html_url: `https://github.com/org/proj/pull/${number}#issuecomment-${id}`,
  ...extra,
});
const closedPr = { number: 7, state: "closed", merged: false, closed_at: T0, user: { login: "newbie" } };

test("/vouch allow: commits to the list and reopens the PR", async () => {
  const { code, writes, listText, output } = await runAction({
    list: "alice\n",
    vouchTeam: "org/maintainers",
    team: ["Maint"],
    comments: [comment(1, "maint", "/vouch allow")],
    pulls: { 7: closedPr },
  });
  assert.equal(code, 0);
  assert.equal(listText, "alice\nnewbie\n");
  assert.deepEqual(writes, [
    [
      "PUT",
      "/repos/org/gov/contents/approved.txt",
      "Bearer list-tok",
      {
        message: "allow newbie by maint\n\nVia: https://github.com/org/proj/pull/7#issuecomment-1",
        content: b64("alice\nnewbie\n"),
        sha: "sha0",
      },
    ],
    ["PATCH", "/repos/org/proj/pulls/7", "Bearer pr-tok", { state: "open" }],
  ]);
  assert.equal(output, "closed=[]\n");
});

test("/vouch allow keeps an open PR open in the same run", async () => {
  const { writes, listText, output } = await runAction({
    pages: [["newbie"]],
    list: "alice\n",
    vouchTeam: "org/maintainers",
    team: ["maint"],
    comments: [comment(1, "maint", "/vouch allow")],
    pulls: { 7: { ...closedPr, state: "open", closed_at: null } },
  });
  assert.equal(listText, "alice\nnewbie\n");
  assert.deepEqual(writes.map(([m, u]) => [m, u]), [["PUT", "/repos/org/gov/contents/approved.txt"]]);
  assert.equal(output, "closed=[]\n");
});

test("/vouch allow for an already-listed author: no commit", async () => {
  const { writes } = await runAction({
    list: "alice\nnewbie\n",
    vouchTeam: "org/maintainers",
    team: ["maint"],
    comments: [comment(1, "maint", "/vouch allow")],
    pulls: { 7: closedPr },
  });
  assert.deepEqual(writes.map(([m, u]) => [m, u]), [["PATCH", "/repos/org/proj/pulls/7"]]);
});

test("two vouches in one run chain list updates", async () => {
  const { writes, listText } = await runAction({
    list: "alice\n",
    vouchTeam: "org/maintainers",
    team: ["maint"],
    comments: [comment(1, "maint", "/vouch allow", 7), comment(2, "maint", "/vouch allow", 8)],
    pulls: {
      7: { ...closedPr, state: "open" },
      8: { ...closedPr, number: 8, state: "open", user: { login: "other" } },
    },
  });
  assert.equal(listText, "alice\nnewbie\nother\n");
  assert.deepEqual(writes.map(([, , , b]) => b.sha), ["sha0", "sha1"]);
});

test("PR closed after the vouch is not reopened", async () => {
  const { writes } = await runAction({
    list: "alice\nnewbie\n",
    vouchTeam: "org/maintainers",
    team: ["maint"],
    comments: [comment(1, "maint", "/vouch allow")],
    pulls: { 7: { ...closedPr, closed_at: "2026-11-16T11:00:00Z" } },
  });
  assert.deepEqual(writes, []);
});

test("ignored vouches: non-team, edited, unknown command, issues, non-vouch", async () => {
  const { writes, requests } = await runAction({
    list: "alice\n",
    vouchTeam: "org/maintainers",
    team: ["maint"],
    comments: [
      comment(1, "mallory", "/vouch allow"),
      comment(2, "maint", "/vouch allow", 7, { updated_at: "2026-11-16T10:06:00Z" }),
      comment(3, "maint", "/vouch deny"),
      comment(6, "maint", "/vouch toString"),
      comment(4, "maint", "/vouch allow", 9, {
        html_url: "https://github.com/org/proj/issues/9#issuecomment-4",
      }),
      comment(5, "maint", "lgtm, /vouch allow"),
    ],
    pulls: { 7: closedPr },
  });
  assert.deepEqual(writes, []);
  assert.ok(!requests.some((r) => /\/pulls\/\d+$/.test(r.url)));
});

const at = (minute) => `2026-11-16T10:${String(minute).padStart(2, "0")}:00Z`;
const timed = (id, login, body, minute, number = 7) =>
  comment(id, login, body, number, { created_at: at(minute), updated_at: at(minute) });

for (const command of ["revoke", "block"]) {
  test(`/vouch ${command}: removes the author and the sweep closes their PR`, async () => {
    const { writes, listText, output } = await runAction({
      pages: [["newbie"]],
      list: "alice\nnewbie  # was vouched\n",
      vouchTeam: "org/maintainers",
      team: ["maint"],
      comments: [comment(1, "maint", `/vouch ${command}`)],
      pulls: { 7: { ...closedPr, number: 1, state: "open", closed_at: null } },
    });
    assert.equal(listText, "alice\n");
    assert.deepEqual(writes[0].slice(0, 3), ["PUT", "/repos/org/gov/contents/approved.txt", "Bearer list-tok"]);
    assert.equal(
      writes[0][3].message,
      `${command} newbie by maint\n\nVia: https://github.com/org/proj/pull/7#issuecomment-1`,
    );
    assert.equal(output, "closed=[1]\n");
  });
}

test("/vouch revoke for an unlisted author: no commit", async () => {
  const { writes } = await runAction({
    list: "alice\n",
    vouchTeam: "org/maintainers",
    team: ["maint"],
    comments: [comment(1, "maint", "/vouch revoke")],
    pulls: { 7: closedPr },
  });
  assert.deepEqual(writes, []);
});

test("latest vouch wins: allow then revoke leaves the author off and closed", async () => {
  const { writes } = await runAction({
    list: "alice\n",
    vouchTeam: "org/maintainers",
    team: ["maint"],
    // Returned out of order to check sorting.
    comments: [timed(2, "maint", "/vouch revoke", 6), timed(1, "maint", "/vouch allow", 5)],
    pulls: { 7: closedPr },
  });
  assert.deepEqual(writes, []);
});

test("latest vouch wins: revoke then allow (on another PR) re-adds", async () => {
  const { writes, listText } = await runAction({
    list: "alice\nnewbie\n",
    vouchTeam: "org/maintainers",
    team: ["maint"],
    comments: [timed(1, "maint", "/vouch block", 5, 7), timed(2, "maint", "/vouch allow", 6, 8)],
    pulls: { 7: closedPr, 8: { ...closedPr, number: 8 } },
  });
  // Already listed, so no commit; only PR 8, vouched for after the block, reopens.
  assert.equal(listText, "alice\nnewbie\n");
  assert.deepEqual(writes.map(([m, u]) => [m, u]), [["PATCH", "/repos/org/proj/pulls/8"]]);
});

test("allow on two PRs by the same author: one commit, both reopened", async () => {
  const { writes } = await runAction({
    list: "alice\n",
    vouchTeam: "org/maintainers",
    team: ["maint"],
    comments: [timed(1, "maint", "/vouch allow", 5, 7), timed(2, "maint", "/vouch allow", 6, 8)],
    pulls: { 7: closedPr, 8: { ...closedPr, number: 8 } },
  });
  assert.deepEqual(writes.map(([m, u]) => [m, u]), [
    ["PUT", "/repos/org/gov/contents/approved.txt"],
    ["PATCH", "/repos/org/proj/pulls/7"],
    ["PATCH", "/repos/org/proj/pulls/8"],
  ]);
  assert.match(writes[0][3].message, /issuecomment-2$/);
});

test("unreadable vouch team: fails without closing", async () => {
  const { code, writes } = await runAction({
    pages: [["mallory"]],
    list: "alice\n",
    vouchTeam: "org/maintainers",
    team: null,
  });
  assert.equal(code, 1);
  assert.deepEqual(writes, []);
});

test("no vouch-team: comments are not read", async () => {
  const { requests } = await runAction({ list: "alice\n" });
  assert.ok(!requests.some((r) => r.url.includes("/comments") || r.url.includes("/teams/")));
});
