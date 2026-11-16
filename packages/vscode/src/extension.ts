/**
 * a4a in VS Code (docs/architecture.md, D46): the Issues view (a search, yours by default), an issue
 * opened beside the code and changed with a command, an issue made from the selected code, an
 * issue named in the commit message, and a4a's MCP server offered to VS Code's agent.
 *
 * Signing in goes through a4a's OAuth (oauth.ts), or a personal API token; either is kept in VS
 * Code's SecretStorage, never in settings.
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { A4a, A4aError, fromSelection, ISSUE_ID, nameIssue, type IssueRow } from './a4a';
import { issueHtml } from './issue-html';
import { refresh, signIn, type Tokens } from './oauth';

const SECRET = 'a4a.tokens';

/** What's kept in SecretStorage: an OAuth sign-in, or an API token, for one a4a. */
interface Kept {
  base: string;
  apiToken?: string;
  oauth?: Tokens;
}

export function baseOf(raw: string): string | null {
  const t = raw.trim().replace(/\/+$/, '');
  if (!t) return null;
  try {
    const u = new URL(t);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export class Session {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async kept(): Promise<Kept | null> {
    const raw = await this.secrets.get(SECRET);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Kept;
    } catch {
      return null;
    }
  }

  async keep(k: Kept | null): Promise<void> {
    if (k) await this.secrets.store(SECRET, JSON.stringify(k));
    else await this.secrets.delete(SECRET);
  }

  /** A token that works now: an API token, or an OAuth one, refreshed when it has run out. */
  async token(): Promise<string | null> {
    const k = await this.kept();
    if (!k) return null;
    if (k.apiToken) return k.apiToken;
    if (!k.oauth) return null;
    if (k.oauth.expiresAt && k.oauth.expiresAt - 60_000 < Date.now()) {
      try {
        const fresh = await refresh(k.base, k.oauth);
        await this.keep({ ...k, oauth: fresh });
        return fresh.accessToken;
      } catch {
        return null;
      }
    }
    return k.oauth.accessToken;
  }
}

class IssueItem extends vscode.TreeItem {
  constructor(readonly issue: IssueRow) {
    super(`${issue.id} ${issue.summary}`, vscode.TreeItemCollapsibleState.None);
    this.description = [issue.state, issue.priority].filter(Boolean).join(' · ');
    this.tooltip = `${issue.id}: ${issue.summary}${issue.assignee ? `\nAssignee: ${issue.assignee}` : ''}\nUpdated ${issue.updated}`;
    this.contextValue = 'issue';
    this.command = { command: 'a4a.openIssue', title: 'Open', arguments: [issue.id] };
  }
}

export class IssuesView implements vscode.TreeDataProvider<IssueItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  query: string | null = null;

  constructor(private readonly client: () => Promise<A4a | null>) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(item: IssueItem): vscode.TreeItem {
    return item;
  }

  async getChildren(): Promise<IssueItem[]> {
    const a4a = await this.client();
    if (!a4a) return [];
    const query = this.query ?? vscode.workspace.getConfiguration('a4a').get<string>('query') ?? 'for: me #Unresolved';
    try {
      const found = await a4a.search(query, 50);
      return found.issues.map((i) => new IssueItem(i));
    } catch (e) {
      void vscode.window.showWarningMessage(e instanceof Error ? e.message : String(e));
      return [];
    }
  }
}

/** A commit message's box, through VS Code's git extension. */
function commitBox(): { value: string } | null {
  const git = vscode.extensions.getExtension<{ getAPI(v: 1): { repositories: { inputBox: { value: string } }[] } }>('vscode.git');
  const api = git?.isActive ? git.exports.getAPI(1) : null;
  return api?.repositories[0]?.inputBox ?? null;
}

export function activate(context: vscode.ExtensionContext): void {
  const session = new Session(context.secrets);
  const client = async (): Promise<A4a | null> => {
    const k = await session.kept();
    return k ? new A4a(k.base, () => session.token()) : null;
  };
  const must = async (): Promise<A4a> => {
    const a4a = await client();
    if (!a4a) throw new A4aError('Sign in to a4a first: a4a: Sign in.', 'auth');
    return a4a;
  };
  const view = new IssuesView(client);
  const said = (e: unknown) => void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
  const mcpChanged = new vscode.EventEmitter<void>();
  const signedIn = async () => {
    await vscode.commands.executeCommand('setContext', 'a4a.signedIn', Boolean(await session.kept()));
    view.refresh();
    mcpChanged.fire();
  };

  const askBase = async (): Promise<string | null> => {
    const configured = baseOf(vscode.workspace.getConfiguration('a4a').get<string>('url') ?? '');
    if (configured) return configured;
    const typed = await vscode.window.showInputBox({ title: "Your a4a's address", placeHolder: 'https://a4a.acme.example', ignoreFocusOut: true, validateInput: (v) => (baseOf(v) ? null : 'An https address') });
    const base = typed ? baseOf(typed) : null;
    if (base) await vscode.workspace.getConfiguration('a4a').update('url', base, vscode.ConfigurationTarget.Global);
    return base;
  };

  const tree = vscode.window.createTreeView('a4a.issues', { treeDataProvider: view, showCollapseAll: false });
  context.subscriptions.push(tree, mcpChanged);

  const commands: Record<string, (...args: never[]) => unknown> = {
    'a4a.signIn': async () => {
      const base = await askBase();
      if (!base) return;
      try {
        const before = await session.kept();
        const oauth = await signIn(base, (url) => vscode.env.openExternal(vscode.Uri.parse(url)), { clientId: before?.base === base ? before.oauth?.clientId : null });
        await session.keep({ base, oauth });
        const me = await new A4a(base, () => session.token()).me();
        void vscode.window.showInformationMessage(`Signed in to a4a as ${me.name}.`);
        await signedIn();
      } catch (e) {
        said(e);
      }
    },
    'a4a.useToken': async () => {
      const base = await askBase();
      if (!base) return;
      const token = await vscode.window.showInputBox({ title: 'An a4a API token', prompt: 'Make one in a4a: your profile, API tokens.', password: true, ignoreFocusOut: true });
      if (!token?.trim()) return;
      await session.keep({ base, apiToken: token.trim() });
      try {
        const me = await new A4a(base, () => session.token()).me();
        void vscode.window.showInformationMessage(`a4a knows the token as ${me.name}.`);
      } catch (e) {
        await session.keep(null);
        said(e);
      }
      await signedIn();
    },
    'a4a.signOut': async () => {
      await session.keep(null);
      await signedIn();
    },
    'a4a.refresh': () => view.refresh(),
    'a4a.search': async () => {
      const query = await vscode.window.showInputBox({ title: 'Search a4a', value: view.query ?? '', placeHolder: 'project: BACK #Unresolved' });
      if (query === undefined) return;
      view.query = query.trim() || null;
      tree.title = view.query ? `Issues: ${view.query}` : 'Issues';
      view.refresh();
    },
    'a4a.openIssue': async (id?: string) => {
      try {
        const a4a = await must();
        const which = id ?? (await vscode.window.showInputBox({ title: 'Open an issue', placeHolder: 'BACK-12', validateInput: (v) => (ISSUE_ID.test(v.trim()) ? null : 'An issue id, such as BACK-12') }))?.trim();
        if (!which) return;
        const issue = await a4a.issue(which);
        const panel = vscode.window.createWebviewPanel('a4a.issue', issue.id, vscode.ViewColumn.Beside, {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
        });
        const nonce = randomBytes(16).toString('base64');
        const style = (f: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'ocean', 'css', f)).toString();
        panel.webview.html = issueHtml(issue, { cspSource: panel.webview.cspSource, styles: [style('tokens.css'), style('components.css')], nonce });
        panel.webview.onDidReceiveMessage(async (m: { type?: string; issue?: string; text?: string }) => {
          if (m.type !== 'command' || !m.issue || !m.text?.trim()) return;
          try {
            await a4a.apply(m.issue, m.text.trim());
            void panel.webview.postMessage({ type: 'said', text: `Applied: ${m.text.trim()}` });
            view.refresh();
          } catch (e) {
            void panel.webview.postMessage({ type: 'said', text: e instanceof Error ? e.message : String(e) });
          }
        });
      } catch (e) {
        said(e);
      }
    },
    'a4a.applyCommand': async (item?: IssueItem) => {
      try {
        const a4a = await must();
        const id = item?.issue.id ?? (await vscode.window.showInputBox({ title: 'Which issue', placeHolder: 'BACK-12' }))?.trim();
        if (!id) return;
        const command = await vscode.window.showInputBox({ title: `A command for ${id}`, placeHolder: 'State Fixed, for me, tag regression' });
        if (!command?.trim()) return;
        await a4a.apply(id, command.trim());
        void vscode.window.showInformationMessage(`${id}: ${command.trim()}`);
        view.refresh();
      } catch (e) {
        said(e);
      }
    },
    'a4a.newIssueFromSelection': async () => {
      try {
        const a4a = await must();
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) return void vscode.window.showInformationMessage('Select the code the issue is about first.');
        const project = await vscode.window.showInputBox({ title: 'New issue in the project', placeHolder: 'BACK', validateInput: (v) => (/^[A-Za-z][A-Za-z0-9]{1,9}$/.test(v.trim()) ? null : "A project's key, such as BACK") });
        if (!project) return;
        const sel = editor.selection;
        const draft = fromSelection({
          path: vscode.workspace.asRelativePath(editor.document.uri),
          startLine: sel.start.line + 1,
          endLine: sel.end.line + 1,
          code: editor.document.getText(sel),
          language: editor.document.languageId,
        });
        const summary = await vscode.window.showInputBox({ title: 'Its summary', value: draft.summary });
        if (!summary?.trim()) return;
        const made = await a4a.create(project.trim().toUpperCase(), summary.trim(), draft.description);
        const open = await vscode.window.showInformationMessage(`${made.id} is made.`, 'Open it');
        if (open) await vscode.commands.executeCommand('a4a.openIssue', made.id);
        view.refresh();
      } catch (e) {
        said(e);
      }
    },
    'a4a.insertIssueId': async () => {
      try {
        const a4a = await must();
        const box = commitBox();
        if (!box) return void vscode.window.showInformationMessage('Open a git repository first: the issue goes in its commit message.');
        const mine = await a4a.search(vscode.workspace.getConfiguration('a4a').get<string>('query') ?? 'for: me #Unresolved', 50);
        const picked = await vscode.window.showQuickPick(
          mine.issues.map((i) => ({ label: i.id, description: i.summary, detail: [i.state, i.priority].filter(Boolean).join(' · ') })),
          { title: 'Which issue the commit is for', placeHolder: 'A commit naming it links to it; BACK-12 #Fixed also applies the command' },
        );
        if (picked) box.value = nameIssue(box.value, picked.label);
      } catch (e) {
        said(e);
      }
    },
  };
  for (const [name, run] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(name, run as (...args: unknown[]) => unknown));

  // a4a's MCP server, for VS Code's agent: with the token kept here, or for VS Code to sign in itself.
  if (vscode.lm?.registerMcpServerDefinitionProvider) {
    context.subscriptions.push(
      vscode.lm.registerMcpServerDefinitionProvider('a4a', {
        onDidChangeMcpServerDefinitions: mcpChanged.event,
        provideMcpServerDefinitions: async () => {
          const k = await session.kept();
          const base = k?.base ?? baseOf(vscode.workspace.getConfiguration('a4a').get<string>('url') ?? '');
          return base ? [new vscode.McpHttpServerDefinition('a4a', vscode.Uri.parse(`${base}/mcp`))] : [];
        },
        resolveMcpServerDefinition: async (server: vscode.McpServerDefinition) => {
          const token = await session.token();
          if (token && server instanceof vscode.McpHttpServerDefinition) server.headers = { ...server.headers, Authorization: `Bearer ${token}` };
          return server;
        },
      }),
    );
  }
  void signedIn();
}

export function deactivate(): void {}
