/**
 * A stand-in for VS Code's API, as much of it as the extension uses: enough to activate it, run its
 * commands with answers given in advance, and see what it registered and showed.
 */
type Fn = (...args: never[]) => unknown;

export const state = {
  commands: new Map<string, Fn>(),
  inputs: [] as (string | undefined)[],
  picks: [] as (string | undefined)[],
  shown: [] as { level: 'info' | 'warn' | 'error'; text: string }[],
  opened: [] as string[],
  config: new Map<string, unknown>(),
  panels: [] as { html: string; posted: unknown[]; receive?: (m: unknown) => unknown }[],
  mcp: null as null | { provideMcpServerDefinitions(): Promise<unknown[]>; resolveMcpServerDefinition(s: unknown): Promise<unknown> },
  editor: null as null | { text: string; startLine: number; endLine: number; path: string; languageId: string },
  commitBox: null as null | { value: string },
  reset() {
    this.commands.clear();
    this.inputs = [];
    this.picks = [];
    this.shown = [];
    this.opened = [];
    this.config.clear();
    this.panels = [];
    this.mcp = null;
    this.editor = null;
    this.commitBox = null;
  },
};

export class EventEmitter<T> {
  private listeners: ((v: T) => void)[] = [];
  event = (l: (v: T) => void) => {
    this.listeners.push(l);
    return { dispose() {} };
  };
  fire(v: T): void {
    for (const l of this.listeners) l(v);
  }
  dispose(): void {}
}

export enum TreeItemCollapsibleState {
  None = 0,
}

export class TreeItem {
  description?: string;
  tooltip?: string;
  contextValue?: string;
  command?: unknown;
  constructor(
    readonly label: string,
    readonly collapsibleState?: TreeItemCollapsibleState,
  ) {}
}

export class Uri {
  constructor(readonly value: string) {}
  static parse(v: string): Uri {
    return new Uri(v);
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri([base.value, ...parts].join('/'));
  }
  toString(): string {
    return this.value;
  }
}

export enum ViewColumn {
  Beside = -2,
}
export enum ConfigurationTarget {
  Global = 1,
}

export class McpServerDefinition {}
export class McpHttpServerDefinition extends McpServerDefinition {
  headers: Record<string, string> = {};
  constructor(
    readonly label: string,
    readonly uri: Uri,
  ) {
    super();
  }
}

const dispose = { dispose() {} };

export const window = {
  createTreeView: () => ({ title: 'Issues', dispose() {} }),
  showInputBox: async () => state.inputs.shift(),
  showQuickPick: async (items: { label: string }[]) => {
    const want = state.picks.shift();
    return items.find((i) => i.label === want);
  },
  showInformationMessage: async (text: string) => {
    state.shown.push({ level: 'info', text });
    return undefined;
  },
  showWarningMessage: async (text: string) => {
    state.shown.push({ level: 'warn', text });
    return undefined;
  },
  showErrorMessage: async (text: string) => {
    state.shown.push({ level: 'error', text });
    return undefined;
  },
  createWebviewPanel: () => {
    const panel = { html: '', posted: [] as unknown[], receive: undefined as undefined | ((m: unknown) => unknown) };
    state.panels.push(panel);
    return {
      webview: {
        cspSource: 'vscode-webview://a4a',
        asWebviewUri: (u: Uri) => new Uri(`vscode-webview://a4a/${u.value}`),
        set html(v: string) {
          panel.html = v;
        },
        get html() {
          return panel.html;
        },
        onDidReceiveMessage: (f: (m: unknown) => unknown) => {
          panel.receive = f;
          return dispose;
        },
        postMessage: async (m: unknown) => {
          panel.posted.push(m);
          return true;
        },
      },
    };
  },
  get activeTextEditor() {
    const e = state.editor;
    if (!e) return undefined;
    return {
      selection: { isEmpty: !e.text, start: { line: e.startLine - 1 }, end: { line: e.endLine - 1 } },
      document: { uri: new Uri(e.path), languageId: e.languageId, getText: () => e.text },
    };
  },
};

export const commands = {
  registerCommand: (name: string, f: Fn) => {
    state.commands.set(name, f);
    return dispose;
  },
  executeCommand: async (name: string, ...args: unknown[]) => (state.commands.get(name) as ((...a: unknown[]) => unknown) | undefined)?.(...args),
};

export const workspace = {
  getConfiguration: () => ({
    get: <T>(key: string) => state.config.get(key) as T | undefined,
    update: async (key: string, value: unknown) => void state.config.set(key, value),
  }),
  asRelativePath: (u: Uri) => u.value,
};

export const env = {
  openExternal: async (u: Uri) => {
    state.opened.push(u.value);
    return true;
  },
};

export const extensions = {
  getExtension: () => (state.commitBox ? { isActive: true, exports: { getAPI: () => ({ repositories: [{ inputBox: state.commitBox }] }) } } : undefined),
};

export const lm = {
  registerMcpServerDefinitionProvider: (_id: string, provider: NonNullable<typeof state.mcp>) => {
    state.mcp = provider;
    return dispose;
  },
};

export interface SecretStorage {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export type ExtensionContext = { subscriptions: { dispose(): void }[]; secrets: SecretStorage; extensionUri: Uri };
export type TreeDataProvider<T> = { getChildren(): Promise<T[]> };
