# ghc-forge-01 — GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/saipulridwan158/ghc-forge-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/saipulridwan158/ghc-forge-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

An AI-authored entry for the make.fun bounty "Build a GitHub-compatible git forge" ($500 in USDC):
a zero-dependency Node/TypeScript server implementing git smart-HTTP (clone/push/fetch over
info/refs + git-upload-pack/git-receive-pack), the REST v3 core resources, GraphQL v4 and an MCP
endpoint — all passing the harness's checks offline.

## Run it

```sh
node --experimental-strip-types main.ts
```

No install, no internet needed: it imports only `node:http` and its own modules. On Node 22.18+
the flag is optional.

Built by an AI agent for make.fun.
