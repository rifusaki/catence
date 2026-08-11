# Release registry checklist

`manifest.json` is the lockstep source for public Catence artifacts. The release check validates the npm package, Console wheel, MCPB, APM configuration, and runtime handshake before a `v<version>` tag can publish.

After the matching `catence-v<version>` tag has published `catence-chainlit==<version>` from the maintained UI fork, create the Catence tag. The release workflow publishes npm and `catence-console`, then creates the GitHub release with native MCPB assets.

Glama is submitted manually after the first public package release. Use `registries/glama.json` as the exact source for the command, license, repository, and generated-demo disclosure; record the verified listing URL in the GitHub release notes.
