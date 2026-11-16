import { test } from "node:test";
import assert from "node:assert/strict";
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
} from "../src/lib.js";

test("parseList ignores comments, blanks, @ prefixes, and case", () => {
  const logins = parseList("# maintainers\nAlice\n\n  @bob  # reviewer\r\ndependabot[bot]\n");
  assert.deepEqual([...logins], ["alice", "bob", "dependabot[bot]"]);
});

test("isApproved is case-insensitive", () => {
  const logins = parseList("alice\n");
  assert.ok(isApproved(logins, "ALICE"));
  assert.ok(!isApproved(logins, "mallory"));
});

test("renderMessage substitutes every {author}", () => {
  assert.equal(renderMessage("Hi @{author}, {author}!", "bob"), "Hi @bob, bob!");
});

test("parsePair", () => {
  assert.deepEqual(parsePair("org/repo.name", "x"), ["org", "repo.name"]);
  assert.throws(() => parsePair("org", "x"), /x must be/);
  assert.throws(() => parsePair("a/b/c", "x"));
});

test("parseVouch", () => {
  assert.equal(parseVouch("/vouch allow"), "allow");
  assert.equal(parseVouch("  /vouch   allow  them\nthanks"), "allow");
  assert.equal(parseVouch("/vouch"), "");
  assert.equal(parseVouch("/vouch deny"), "deny");
  assert.equal(parseVouch("/vouchallow"), null);
  assert.equal(parseVouch("please /vouch allow"), null);
  assert.equal(parseVouch(""), null);
});

test("removeLogin drops matching lines only", () => {
  assert.equal(
    removeLogin("# team\nalice\n@Bob  # reviewer\ncarol\n", "bob"),
    "# team\nalice\ncarol\n",
  );
  assert.equal(removeLogin("alice\r\nbob", "BOB"), "alice\r\n");
  assert.equal(removeLogin("alice\n", "bob"), "alice\n");
});

test("appendLogin", () => {
  assert.equal(appendLogin("alice\n", "bob"), "alice\nbob\n");
  assert.equal(appendLogin("alice", "bob"), "alice\nbob\n");
  assert.equal(appendLogin("", "bob"), "bob\n");
});

test("contentsUrl encodes path segments and ref", () => {
  assert.equal(
    contentsUrl("https://api.github.com", "o/r", "/lists/my list.txt", "main"),
    "https://api.github.com/repos/o/r/contents/lists/my%20list.txt?ref=main",
  );
  assert.equal(
    contentsUrl("https://api.github.com", "o/r", "a.txt", undefined),
    "https://api.github.com/repos/o/r/contents/a.txt",
  );
});

test("nextLink", () => {
  assert.equal(
    nextLink('<https://x/p?page=2>; rel="next", <https://x/p?page=5>; rel="last"'),
    "https://x/p?page=2",
  );
  assert.equal(nextLink('<https://x/p?page=1>; rel="prev"'), null);
  assert.equal(nextLink(null), null);
});
