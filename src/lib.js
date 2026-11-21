// Format: one GitHub login per line. Blank lines and `#` comments are
// ignored; a leading `@` is optional. Logins are case-insensitive.
export function parseList(text) {
  const logins = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    logins.add(line.replace(/^@/, "").toLowerCase());
  }
  return logins;
}

export function isApproved(logins, author) {
  return logins.has(author.toLowerCase());
}

// Lines that must keep their own line: blank, indented (code), lists,
// headings, quotes, tables, fences, and rules.
const STANDALONE = /^(\s*$|\s|[-*+>#|]|\d+[.)]\s|```|~~~)/;

// GitHub renders every newline in a comment as a line break, so lines
// hard-wrapped in YAML are joined back into flowing paragraphs.
export function unwrap(text) {
  const out = [];
  let fenced = false;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const fence = /^(```|~~~)/.test(line);
    const prev = out.length ? out[out.length - 1] : null;
    if (!fenced && !fence && prev !== null && !STANDALONE.test(prev) && !STANDALONE.test(line)) {
      out[out.length - 1] = `${prev} ${line.trim()}`;
    } else {
      out.push(line);
    }
    if (fence) fenced = !fenced;
  }
  return out.join("\n");
}

export function renderMessage(template, author) {
  return unwrap(template).replaceAll("{author}", author);
}

export function appendLogin(text, login) {
  return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${login}\n`;
}

// Drops every line naming `login`, keeping all other lines byte-for-byte.
export function removeLogin(text, login) {
  const target = login.toLowerCase();
  return text
    .split(/(?<=\n)/)
    .filter((line) => !parseList(line).has(target))
    .join("");
}

// Returns the subcommand of a comment whose first line starts with `/vouch`,
// or null for any other comment. A bare `/vouch` means "allow".
export function parseVouch(body) {
  const [command, sub = "allow"] = body.trim().split(/\r?\n/)[0].trim().split(/\s+/);
  return command === "/vouch" ? sub : null;
}

// Parses "owner/repo" or "org/team-slug".
export function parsePair(value, inputName) {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(value);
  if (!m) throw new Error(`${inputName} must be "owner/name", got "${value}"`);
  return [m[1], m[2]];
}

export function contentsUrl(apiUrl, repo, path, ref) {
  const encodedPath = path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
  const url = new URL(`${apiUrl}/repos/${repo}/contents/${encodedPath}`);
  if (ref) url.searchParams.set("ref", ref);
  return url.toString();
}

export function nextLink(linkHeader) {
  const m = /<([^>]+)>;\s*rel="next"/.exec(linkHeader ?? "");
  return m ? m[1] : null;
}
