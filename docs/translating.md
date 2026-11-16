# Translating a4a

a4a speaks to each person in their own language (D49 in [architecture.md](architecture.md)). English is the source; German is complete. This page says how a4a sounds in a language, the words German chose for a4a's terms, how to check a language, and how to add one.

## What is translated, and what isn't

Translated: every word the web app says (pages, buttons, labels, empty states, problems, the tour's pages, the names screen readers read), and what a4a sends people: emails, the inbox's titles, push notifications, and the buttons on chat cards.

Not translated:

- **What people named**: projects, fields and their values, states, tags, link types, saved searches, rules, boards. `State`, `Priority`, `In Progress` and `Won't fix` are data, so a query or a command says them as they were named.
- **The query and command languages**: `project: BACK #Unresolved for: me` and `State Fixed` read the same everywhere. Examples of them in a page's words stay as they are.
- **The API's and MCP's own words**: what `/api/v1` answers and what the MCP tools say are for programs and agents, in English. A problem carries a key and values beside its English, so a page says it in its person's language.
- **The tour**: its words come from the catalog like any page's, but the browser suite takes it in English.

## The catalogs

One file per language in `packages/shared/i18n/`: `en.json`, `de.json`. Each holds every message as [ICU MessageFormat](https://unicode-org.github.io/icu/userguide/format_parse/messages/), keyed by what it is for and where: `page.profile.language`, `issues.commandBar.noChange`, `server.notify.title.assigned`, `problem.wrongLogin`.

- `{name}` is a value a4a puts in. Keep each one, spelled the same, as many as English has.
- `{n, plural, one {# Vorgang} other {# Vorgänge}}` chooses by number; `#` is the number in the language's own digits.
- `<t0>…</t0>` is a link or emphasis around words: keep it around the words that mean the same.
- A leading or trailing space in English is there because the message sits beside another: keep it.
- `'{'` writes a brace, and `''` an apostrophe before one.

Messages are whole sentences where English could make them so, but some are pieces a page puts together: "{who} {did}" in an email, "an issue is created" after "When". The key's prefix says where a piece goes; read the pieces of one prefix together.

## The voice

a4a writes as it does in English: short sentences, plain words, the thing named rather than described, no exclamation marks, no "please" except where something is asked of someone. It says what happened and what to do next.

German:

- **Sie**, always: "Speichern Sie zuerst", "Ihr Profil". Never "du".
- **Buttons are infinitives or nouns**: "Speichern", "Änderung speichern", "Abbrechen". A button that names what it changes says it: "Feld löschen", not "Löschen" alone, where English says "Delete the field".
- **Status lines are passive or perfect**: "Gespeichert.", "Wird gespeichert…", "{name} ist hinzugefügt."
- **Gender**: a4a doesn't guess a person's. It says "die Person", "wer …", "alle, die …" where English says "they". Roles stay as their words, "Administrator", "Manager", "Mitglied", "Betrachter".
- **Nouns keep their capital** inside a sentence, so a label set into a sentence isn't lower-cased in German (`inSentence()` in the web's `i18n`).
- **Dates and numbers** come from Intl, never from the catalog: "16. Nov. 2026", "1.234,5", "vor 3 Minuten".
- Quotation marks are „…“, and the ellipsis is one character, as in English.

## The terms

| English | German |
|---|---|
| issue | Vorgang |
| project | Projekt |
| board | Board |
| sprint | Sprint |
| backlog | Backlog |
| help desk | Helpdesk |
| request (help desk) | Anfrage |
| requester | anfragende Person |
| reporter | meldende Person |
| assignee | Bearbeiter (a column), zugewiesene Person |
| agent | Agent |
| workflow | Workflow |
| rule | Regel |
| state machine | Zustandsautomat |
| transition | Übergang |
| knowledge base | Wissensdatenbank |
| article | Artikel |
| inbox | Posteingang |
| notification | Benachrichtigung |
| digest | Überblick |
| subscription, subscribe | Abonnement, abonnieren |
| watch, watcher | beobachten, Beobachtende |
| timesheet | Stundenzettel |
| work logged, log time | erfasste Arbeit, Zeit erfassen |
| estimate | Schätzung |
| days away | Abwesenheiten |
| levelling | Kapazitätsabgleich |
| slack (in a plan) | Puffer |
| baseline | Baseline |
| earned value | Fertigstellungswert |
| triage | Triage |
| suggestion | Vorschlag |
| token | Token |
| two-factor sign-in | Zwei-Faktor-Anmeldung |
| sign in, sign out | anmelden, abmelden |
| identity provider | Identitätsanbieter |
| single sign-on | Single Sign-on |
| webhook, delivery | Webhook, Zustellung |
| secret | Secret |
| commit, pull request, branch | Commit, Pull Request, Branch |
| field, value | Feld, Wert |
| link (between issues) | Verknüpfung |
| resolve, resolved | erledigen, erledigt |
| dashboard, widget | Dashboard, Widget |
| report | Bericht |

## Checking a language

1. `pnpm --filter @a4a/web check:words` (also in `pnpm test`): every catalog has every English key and no other, every message parses, each has English's placeholders and tags, every key the code says is in English, every English key is said somewhere, and no words sit in JSX, in a label map, or in what the server sends people.
2. `pnpm --filter @a4a/server exec vitest run test/translation.test.ts`: an email in each recipient's language, the language on `/me`, and a problem's key.
3. The browser: `e2e/german.spec.ts` takes a German browser through the issues, an issue, the inbox, the profile and the sign-in page, shoots each in light, in dark and at 390px, and fails if a page spills sideways there. Its pictures are in the HTML report (`apps/web/playwright-report`).
4. Read it. Set your profile's language, or your browser's, and walk the pages you know: the inbox, an issue's history, the plan, a rule's sentence, an email (a test server's `SMTP_URL` to a catcher), the help desk's pages signed out. A message that reads wrong in its place is a piece read on its own: find its key with the words beside it, and its prefix's neighbours.

## Adding a language

French, Spanish and Japanese come next, each a catalog:

1. In `packages/shared/src/i18n.ts`, add the code to `LOCALES` and its own name to `LOCALE_NAMES` ("Français", "Español", "日本語").
2. Copy `packages/shared/i18n/en.json` to `<code>.json` and translate every message.
3. In `packages/server/src/i18n.ts`, import the catalog beside the others (the server's catalogs are imported, not globbed).
4. If its nouns keep their capital, as German's do, add it to `CAPITAL_NOUNS` in `apps/web/src/i18n/index.ts`.
5. Write its voice and its terms here, then run the checks above. A copy of `e2e/german.spec.ts` with the language's words checks it in a browser.

The web finds a new catalog by itself, and loads only its person's. A right-to-left language would also need `dir="rtl"` on the page and Ocean's layouts checked (D49 says what holds).

## Japanese

`ja.json`, as Japanese teams read a tracker:

- **The polite form (です・ます) in sentences**: 「保存しました。」, 「先に保存してください。」. Buttons and labels are short nouns or verb phrases, never sentences: 「保存」, 「変更を保存」, 「フィールドを削除」.
- **No honorific after a name**: a name takes its particle directly (「Adaが割り当てました」), since many names are agents' and bots'. The help desk's emails are the one exception: they go to people outside the team, so they address a requester as 「{name}様」, as Japanese customer mail does.
- **Full-width punctuation**: 、。：（）, and 「」 for quotes. The ellipsis is one character (…), as in English. No space between Japanese and a Latin word or a value: 「BACK-12を開く」.
- **Plurals**: Japanese has none, so each plural keeps `other` alone, with a counter word: `{n, plural, other {#件の課題}}`. 件 counts issues and things, 人 people, 個 fields, values, files and tokens, 回 times.
- **Pieces a page joins**:
  - The activity ledger, an issue's history and notifications show who in bold, then what was done. So an action is a verb phrase in the polite past, with no subject: 「{issue}を変更しました」, 「報告しました」. A badge is a noun: 「課題の削除」.
  - A webhook's events are joined into 「{join}とき」 with 「、または」, so each is a clause in the plain past: 「課題が作成された」.
  - A rule's sentence keeps English's order (when, if, then), so Japanese labels its parts 「トリガー：」, 「条件：」 and 「アクション：」, as Japanese automation tools do.
- **English the code passes in a value**:
  - Where a page passes an English word that has no place in Japanese ('its', 'is'/'are', 'rule'/'rules'), the placeholder sits in a select whose only branch is an empty `other`, `{v, select, other {}}`, and says nothing.
  - Where the word is one of a few ('above'/'below', 'earlier'/'later', 'add'/'apply'), a select picks the Japanese word for it.
- **Dates and numbers** come from Intl: 「2026年11月16日」, 「1,234.5」, 「3分前」.
- **Field names, states and values** are data, as in every language: the field panel says STATE and PRIORITY as they were named.

| English | Japanese |
|---|---|
| issue | 課題 |
| summary (an issue's title) | 件名 |
| description | 説明 |
| project | プロジェクト |
| board | ボード |
| sprint | スプリント |
| backlog | バックログ |
| help desk | ヘルプデスク |
| request (help desk) | リクエスト |
| requester | 依頼者 |
| reporter | 報告者 |
| assignee | 担当者 |
| agent | エージェント |
| workflow | ワークフロー |
| rule | ルール |
| state machine | ステートマシン |
| transition | 遷移 |
| state | 状態 |
| knowledge base | ナレッジベース |
| article | 記事 |
| inbox | 受信トレイ |
| notification | 通知 |
| digest | ダイジェスト |
| subscription, subscribe | 購読, 購読する |
| watch, watcher | ウォッチ, ウォッチャー |
| timesheet | タイムシート |
| work logged, log time | 作業記録, 作業時間を記録 |
| estimate | 見積もり |
| days away | 不在日 |
| levelling | 平準化 |
| slack (in a plan) | 余裕 |
| baseline | ベースライン |
| earned value | アーンドバリュー（EV） |
| triage | トリアージ |
| suggestion | 提案 |
| token, revoke | トークン, 無効化 |
| two-factor sign-in | 2段階認証 |
| sign in, sign out | ログイン, ログアウト |
| login (a person's handle) | ログインID |
| identity provider | IDプロバイダー |
| single sign-on | シングルサインオン |
| webhook, delivery | Webhook, 配信 |
| secret | シークレット |
| commit, pull request, branch | コミット, プルリクエスト, ブランチ |
| field, value | フィールド, 値 |
| link (between issues) | リンク |
| resolve, resolved | 解決, 解決済み |
| dashboard, widget | ダッシュボード, ウィジェット |
| report | レポート |
| person, people | ユーザー |
| role, permission | ロール, 権限 |
| member, viewer, manager, administrator | メンバー, 閲覧者, マネージャー, 管理者 |

**Why 課題 for issue**: it's what Jira's and Backlog's Japanese say, so Japanese teams already read trackers in it. チケット (Redmine's) reads as a support ticket, and イシュー, GitHub's loanword, is stiff in a sentence.

**Checking Japanese**: the checks above, and `e2e/japanese.spec.ts`. It signs a person of its own in, through the sign-in page of a Japanese browser, and opens the issues, an issue, the inbox and the profile. It also shows a problem on the sign-in page. It shoots each page in light, in dark and at 390px, into the HTML report and beside the test in `apps/web/test-results`.

A reader of Japanese can then:

- read those shots;
- set a profile's language to 日本語 and walk the pages;
- read the pieces of one prefix together, since a page joins them: `activity.ledgerEntry.*`, `issues.issueHistory.*`, `server.notify.*`, `rules.words.*`.

The shots in this repository's container use its only CJK font, WenQuanYi Zen Hei, a Chinese font, which sets kana in full-width cells. They look looser than on a machine with a Japanese font, so judge spacing with Noto Sans JP or Hiragino.
