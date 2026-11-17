# a4a for VS Code

a4a's issues beside your code.

- **Issues view**: what a search finds, yours by default (`a4a.query`). Search with the view's search button.
- **An issue, opened beside the code**, drawn with Ocean's stylesheet, with a box to apply a command (`State Fixed`, `for me`, `tag regression`).
- **New issue from the selection**: right-click selected code; the issue says where it is and quotes it.
- **Name an issue in the commit message**: the button on the Source Control view puts `BACK-12` at the start; a commit naming an issue links to it in a4a, and `BACK-12 #Fixed` applies the command.
- **a4a's MCP server for VS Code's agent**: offered with the sign-in kept here, so the agent can use a4a's tools.

## Signing in

Set `a4a.url` to your a4a's address, then run **a4a: Sign in**: your browser opens a4a's page to allow it, and comes back to VS Code on a port of this computer. Or run **a4a: Use an API token** with a token from your profile in a4a. Either is kept in VS Code's secret storage, never in settings.

## Building

```bash
pnpm --filter a4a-vscode package
```

This bundles `dist/extension.js`, copies Ocean's stylesheets and fonts into `media/ocean`, and writes `dist/a4a.vsix`, to install with **Extensions: Install from VSIX…**.
