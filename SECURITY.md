# Security policy

## Supported versions

Only the latest release on npm receives security fixes. punchout-simulator is
pre-1.0 and ships small, frequent releases, so the fix for a reported issue goes
into the next patch release rather than being back-ported.

## Reporting a vulnerability

Please report privately, not in a public issue:

1. Open the repository's **Security** tab →
   [**Report a vulnerability**](https://github.com/slawomir-szostak/punchout-simulator/security/advisories/new).
2. Describe what you found, the version (`punchout-simulator --version`), how
   the tool was started (flags such as `--host`, `--public-url`, Docker), and
   steps to reproduce.

You can expect an acknowledgement within a week. Once a fix is released, the
advisory is published and you are credited unless you prefer otherwise.

## What the package installs

`punchout-simulator` has no runtime dependencies: the packages the server needs
are built into the published bundle and listed, with versions and licences, in
`dist/THIRD-PARTY-LICENSES.txt`. Installing it downloads nothing else and runs
no install script. Releases are built and published by GitHub Actions with npm
provenance; CI audits the built-in packages for advisories weekly.

## What counts

punchout-simulator is a developer tool for testing cXML PunchOut integrations.
Its security model is described in the README under
[Exposure & the admin API](README.md#exposure--the-admin-api). In short:

- The admin API (`/api/*`) is unauthenticated **only** on loopback, and requires
  a token as soon as the tool is exposed.
- The buyer-facing surface (`/sim/*`, `/punchout/return`) is open by design.

In scope, for example: reaching `/api/*` without the token when exposed, driving
the localhost API from another website, script injection into the UI through
cXML or imported configuration, shared secrets appearing in logs or exports that
are meant to omit them, reading or writing files outside the data directory.

Out of scope, because they are documented behaviour: the open `/sim` and
`/punchout` endpoints accepting unauthenticated cXML, outbound requests to
URLs an authenticated operator configured (including private addresses — testing
a supplier on `localhost` is the primary use), and anyone holding the API token
being able to read shared secrets.
