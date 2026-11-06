# AGENTS.md notes for the iOS projects (ticket ACP-C1, item 4)

Copy the block below into the `AGENTS.md` of each iOS project the
remote Pi agent works on. It tells the agent (and any ACP-driven
session) how to build/test in this environment.

```markdown
## Xcode / iOS build guidance

- Build, test, and simulator operations go through the Xcode MCP tools
  (build, test, run destination) when available in the session; do not
  shell out to xcodebuild for routine build/test when the MCP tool
  exists.
- NEVER modify code-signing configuration (signing teams, bundle IDs,
  entitlements, provisioning) unless the user explicitly requests it in
  the current task.
- After any code change: build the target, run the relevant test
  targets, fix all compile errors you introduced, and report the
  build/test status (pass/fail + which targets) in the final message.
```

Why it lives here: the remote pi agent cannot see Xcode's UI, so the
project's AGENTS.md is the only channel for these standing rules.
Maintain the snippet in this file; sync it into the iOS projects when
it changes.
