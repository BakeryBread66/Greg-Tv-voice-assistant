# Security

Greg runs on your own machine and touches things worth being careful about: a
microphone that is always listening, your screen, folders you point him at, and
an HTTP server on localhost. This page says how to report a problem, and — more
usefully — what is already known and deliberate, so you can tell a bug from a
design decision.

## Reporting something

**Use GitHub's private vulnerability reporting**: the **Security** tab on this
repository, then **Report a vulnerability**. That keeps the details private until
there is a fix, which is the point.

Please do not open a public issue for anything that would let someone read
another person's files, screen, microphone or conversation log.

It helps to include what you did, what happened, and what you expected — and
whether it needs the attacker to already be on the machine, or works from a web
page the user merely visits. That last distinction changes the severity more than
anything else.

This is a hobby project maintained by one person. Expect a best-effort reply
rather than a service level agreement.

## Supported versions

The latest commit on `main`. There are no maintained release branches, so fixes
land there and nowhere else.

## What is already known and deliberate

None of the following are bugs. They are trade-offs with reasons, and they are
listed here so a report can be about something new.

**The server is localhost-only, but that is not the same as private.** Greg binds
to `127.0.0.1`, so nothing on your network can reach him. Any program running as
you on the same machine still can, and `/api/chat` can call his tools. That is
normal for a local app — Ollama does the same — but it is worth knowing.

**Requests are checked for where they came from.** The `Host` header is validated
so a website cannot reach Greg by pointing its own domain at `127.0.0.1` (DNS
rebinding), and the `Origin` header is checked on anything that changes state. A
missing `Origin` is allowed on purpose, because that is what a terminal or a
script sends and driving Greg from `curl` is a supported thing to do.

**`read_page` will fetch any public URL.** It refuses private and loopback
addresses, so it cannot be turned against your own network, but it is a tool
whose job is to read the web and it does. If a hostile page ever talked the model
into fetching a URL, that URL is a way to carry data outward. See below.

**Prompt injection is mitigated, not solved.** Greg reads web pages, search
results and files that strangers wrote. Their text is labelled as quoted material
and never instructions, and in testing an injected instruction was obeyed 0 times
out of 6 across three payload shapes — but that is a property of one model on one
day, not a guarantee. Treat anything he reads as untrusted, because it is.

**What an injected instruction still could not do**, and this part is structural
rather than probabilistic: **no tool can run a command** (nothing under
`lib/tools/` imports `child_process`), **nothing can write outside a fixed set of
paths** (no tool accepts a filename), and **the file reader cannot write, move or
delete** — `lib/files.js` contains no write operation at all. There are tests
that fail if any of those stop being true.

**File access is opt-in and fenced.** He reads only inside configured roots, with
a deny list that wins over the allow list, and paths are resolved with `realpath`
*before* the root check so a junction or symlink cannot escape. Set
`files.roots` to `[]` to switch the whole thing off.

**Your data stays out of the repository.** `config.json`, `conversations.jsonl`,
`memory.json`, `reminders.json`, `spotify-tokens.json`, `.env`, `voices/` and
`screenshots/` are all gitignored. If you fork this and push, check `git status`
before your first commit anyway.

**Some things do leave the machine, when you ask for them.** Search terms go to
DuckDuckGo, coordinates go to the weather services, and place names go to the
news feed. Your audio, your screen and your conversation do not — provided the
local speech pieces are installed. The startup banner says in amber when they are
not, and the fallbacks are a cloud voice and the browser's own speech
recognition, which do send text and audio respectively.

## Dependencies

Greg has three npm dependencies and no build step. The heavy lifting is done by
separate programs you install yourself — Ollama, faster-whisper, Piper — each
with its own security posture and its own updates.
