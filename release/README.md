# Release registry checklist

`manifest.json` maps the npm version to the Console and Chainlit Python
versions. The release check validates the npm package, Console wheel, MCPB, APM
configuration, and runtime handshake before a `v<version>` tag can publish.

For stable releases, npm and Python use the same final version. Betas use npm
`X.Y.Z-beta.N` and Python `X.Y.ZbN`; see [the beta checklist](beta-checklist.md)
for the required publish order and server validation.
