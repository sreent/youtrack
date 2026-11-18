# a4a for VS Code

a4a's issues beside your code.

- **Issues view**: what a search finds, yours by default (`a4a.query`). Search with the view's search button.
- **An issue, opened beside the code**, drawn with Ocean's stylesheet, with a box to apply a command (`State Fixed`, `for me`, `tag regression`).
- **New issue from the selection**: right-click selected code; the issue says where it is and quotes it.
- **Name an issue in the commit message**: the button on the Source Control view offers your issues and puts the one you pick (`BACK-12`) at the start; a commit naming an issue links to it in a4a, and `BACK-12 #Fixed` applies the command.
- **a4a's MCP server for VS Code's agent**: offered with the sign-in kept here, so the agent can use a4a's tools; without one, VS Code signs in to a4a itself.

## Signing in

Run **a4a: Sign in**. It asks for your a4a's address (https, or http on this computer) unless `a4a.url` has it; your browser opens a4a's page to allow it, and comes back to VS Code on a port of this computer. This needs a4a's OAuth, which is on where its `PUBLIC_URL` is https or this computer. Or run **a4a: Use an API token** with a token from **Agents and tokens** in a4a. Either is kept in VS Code's secret storage, never in settings.

## Building

```bash
pnpm --filter a4a-vscode package
```

This bundles `dist/extension.js`, copies Ocean's stylesheets and fonts into `media/ocean`, and writes `dist/a4a.vsix`, to install with **Extensions: Install from VSIX…** in VS Code 1.101 or later. `pnpm --filter a4a-vscode test` runs its tests against a stand-in for VS Code's API; `pnpm test` at the root runs them too.
