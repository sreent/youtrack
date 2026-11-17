# Translating a4a

a4a speaks to each person in their own language (D49 in [architecture.md](architecture.md)). English is the source; German, Spanish, Japanese, French and Indonesian are complete. This page says how a4a sounds in a language, the words German chose for a4a's terms, how to check a language, and how to add one.

## What is translated, and what isn't

Translated: every word the web app says (pages, buttons, labels, empty states, problems, the tour's pages, the names screen readers read), and what a4a sends people: emails, the inbox's titles, push notifications, and chat: the bot's replies and its cards' words. The bot's commands (`help`, `new`, `search`, `subscribe`) are the same in every language, as the command language's are.

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

What the code gives a message is never English words to choose by:

- **Counts are the message's own plural.** "Apply to {n, plural, one {# issue} other {# issues}}": inflect the noun as the sentence needs ("von # Vorgängen"), and agree the verb with it.
- **Choices are codes.** `{who, select, you {…} other {…}}` (you, or a person by `{name}`), `{target, select, resolution {…} other {…}}`, `{joined, select, yes {…} other {…}}`: word each option in your language; `other` takes whatever else comes.
- **Lists come joined** by the language's own list (Intl.ListFormat): "A, B und C", "A、B、C". Don't add "and" around a `{join}`, `{actions}` or `{states}`.
- **A role is its name alone** outside English, "ist jetzt {role}": English alone adds "a" or "an". A built-in role's name is a message (`roles.builtin.*`); one people made stays as named.
- **A rule is one sentence** per kind (`rules.words.whenSentence`, `rules.words.scheduleSentence`): put its parts in your order.
- **Sizes and numbers** come from Intl ("12,3 MB", "12,3 Mo"), never from the catalog.

## The voice

a4a writes as it does in English: short sentences, plain words, the thing named rather than described, no exclamation marks, no "please" except where something is asked of someone. It says what happened and what to do next.

German:

- **Sie**, always: "Speichern Sie zuerst", "Ihr Profil". Never "du".
- **"Sie" and "Ihr" at a sentence's start are the reader.** A sentence about an app, a rule, a file or a request names it ("Die App verliert sofort den Zugang", "Die Regel ist ausgeschaltet"), and a heading says "Rolle" or "Einstellungen der App", not "Ihre Rolle". A thing that is on or off is "eingeschaltet" or "ausgeschaltet" in a sentence; "Ein" and "Aus" are for options and badges.
- **Buttons are infinitives or nouns**: "Speichern", "Änderung speichern", "Abbrechen". A button that names what it changes says it: "Feld löschen", not "Löschen" alone, where English says "Delete the field".
- **Status lines are passive or perfect**: "Gespeichert.", "Wird gespeichert…", "{name} ist hinzugefügt."
- **What a page loads is a whole message**, passive, with the noun first: "Der Plan wird geladen…", "Ihre Anfragen werden geladen…", "{name} wird geladen…", and "Wird geladen…" when nothing is named.
- **Gender**: a4a doesn't guess a person's. It says "die Person", "wer …", "alle, die …" where English says "they". Roles stay as their words, "Administrator", "Manager", "Mitglied", "Betrachter".
- **Nouns keep their capital** inside a sentence, so a label set into a sentence isn't lower-cased in German (`inSentence()` in the web's `i18n`).
- **Dates and numbers** come from Intl, never from the catalog: "16. Nov. 2026", "1.234,5", "vor 3 Minuten".
- Quotation marks are „…“, and the ellipsis is one character, as in English.
- **Codes are selects**: where a message chooses by a code (`{state, select, merged {…}}`, `{who, select, you {…}}`, `{unit, select, points {…}}`), each case is whole German, in German's order: "hat die Änderung von Ada rückgängig gemacht", "{name} ist bereits vom {from} bis {to} abwesend".

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
| copied on a request (CC), copy, stop copying | in Kopie, in Kopie setzen, aus der Kopie nehmen |
| customer group, kept from the group | Kundengruppe, vor der Gruppe verborgen |
| reporter | meldende Person |
| assignee | Bearbeiter (a column), zugewiesene Person |
| agent | Agent |
| assistant (its name), the assistant | assistant, der Assistent |
| conversation (with the assistant) | Unterhaltung |
| workflow | Workflow |
| rule | Regel |
| if (a rule's or a transition's condition) | falls, after a trigger's „Wenn“ |
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
| rate (per hour) | Stundensatz |
| days away | Abwesenheiten |
| levelling | Kapazitätsabgleich |
| slack (in a plan) | Puffer |
| baseline | Baseline |
| earned value, earned | Fertigstellungswert, erbracht |
| cost and schedule performance (CPI, SPI) | Kosteneffizienz, Termineffizienz |
| triage | Triage |
| suggestion | Vorschlag |
| token | Token |
| two-factor sign-in | Zwei-Faktor-Anmeldung |
| sign in, sign out | anmelden, abmelden |
| login (a person's handle) | der Login |
| identity provider | Identitätsanbieter |
| single sign-on | Single Sign-on |
| webhook, delivery | Webhook, Zustellung |
| secret | Secret |
| commit, pull request, branch | Commit, Pull Request, Branch |
| merge, merged | mergen, gemergt |
| CI | das CI |
| field, value | Feld, Wert |
| link (between issues) | Verknüpfung |
| resolve, resolved, resolution | erledigen, erledigt, Erledigung (an SLA's: Erledigungsziel) |
| dashboard, widget | Dashboard, Widget |
| report | Bericht |

## Checking a language

1. `pnpm --filter @a4a/web check:words` (also in `pnpm test`): every catalog has every English key and no other, every message parses, each has English's placeholders and tags, every key the code says is in English, every English key is said somewhere, and no words sit in JSX, in a label map, or in what the server sends people.
2. `pnpm --filter @a4a/server exec vitest run test/translation.test.ts`: an email in each recipient's language, the language on `/me`, and a problem's key.
3. The browser: `e2e/german.spec.ts` takes a German browser through the issues, an issue, the inbox, the profile and the sign-in page, shoots each in light, in dark and at 390px, and fails if a page spills sideways there. Its pictures are in the HTML report (`apps/web/playwright-report`).
4. Read it. Set your profile's language, or your browser's, and walk the pages you know: the inbox, an issue's history, the plan, a rule's sentence, an email (a test server's `SMTP_URL` to a catcher), the help desk's pages signed out. A message that reads wrong in its place is a piece read on its own: find its key with the words beside it, and its prefix's neighbours.
5. Settle what's left open. No native speaker has read German, Spanish, French, Japanese or Indonesian yet; [translation-questions.md](translation-questions.md) lists, by language, the choices their reviews couldn't settle.

## Adding a language

A language is a catalog, as Spanish, Japanese, French and Indonesian came:

1. In `packages/shared/src/i18n.ts`, add the code to `LOCALES` and its own name to `LOCALE_NAMES`, as its readers write it ("Italiano", "Português").
2. Copy `packages/shared/i18n/en.json` to `<code>.json` and translate every message.
3. In `packages/server/src/i18n.ts`, import the catalog beside the others (the server's catalogs are imported, not globbed).
4. If its nouns keep their capital, as German's do, add it to `CAPITAL_NOUNS` in `apps/web/src/i18n/index.ts`.
5. Write its voice and its terms here, in a section of its own, then run the checks above. A copy of `e2e/spanish.spec.ts` with the language's words checks it in a browser: it signs in a person of its own, not one of the suite's administrators, since German's spec changes Una's language.

The web finds a new catalog by itself, and loads only its person's. A right-to-left language would also need `dir="rtl"` on the page and Ocean's layouts checked (D49 says what holds).

## Spanish

One Spanish for Spain and Latin America: no *vosotros*, and no word only one side uses. Where the two differ, the catalog takes the form most Spanish speakers use and every reader knows: *agregar* (not *añadir*), *costo* (not *coste*), *correo* for email, *PC* where English says computer, *informe* for a report.

- **Tú**, always: "Elige un proyecto", "Tu perfil". Spanish software, Jira's and Slack's among them, says *tú* to its people on both sides of the Atlantic; *usted* reads as a form letter there. German's *Sie* is German's own convention.
- **Buttons are infinitives**: "Guardar", "Guardar los cambios", "Eliminar el campo". Instructions and help are the *tú* imperative: "Elige", "Escribe", "Pulsa".
- **What just happened is the present perfect**: "Se ha guardado.", "Se ha creado {name}.". History and notifications, which carry their time, are the preterite: "la movió", "comentó", "te la asignó".
- **An issue is *incidencia***, feminine, so what refers to one agrees with it: "la notificó", "Notificada por", "resuelta".
- **Gender**: a4a doesn't guess a person's. It says "la persona", "quien…", "quienes la siguen", and takes nouns that don't change: *responsable* (assignee), *solicitante* (requester), *informante*, *agente*, *miembro*. Where a person's gender would show in an adjective, the sentence turns: "Ya no tienes suscripción a…", not "Ya no estás suscrito". Roles stay as their words, as German's do: *administrador*, *gestor*, *miembro*, *lector*. A role's bare name follows a singular: "{name} es ahora {role}"; after a plural it is "tienen al menos el rol {role}". A guest is "con acceso de invitado", never "como invitado".
- **Typography**: opening ¿ and ¡. Quotation marks are “…”, as English's are (« » is Spain's print habit, not Latin America's). A space before % and before a unit: "50 %", "30 s". The ellipsis is one character.
- **Dates and numbers** come from Intl: "16 nov 2026", "1.234,5", "hace 3 minutos".
- **English the page passes in.** Some messages are given an English word as a value ("is"/"are", "field"/"fields", "later"/"earlier", "it"/"them", a pull request's "merged"). The Spanish selects on it, `{v, select, is {…} other {…}}`, so it reads right; where nothing can be selected on, the English shows until the page passes a number or a key instead. Codes are selected on the same way, keeping the code as `other`: a report's `{interval}` (day, week, month) and `{word}` (state, column), a Gantt bar's `{part}` (morning, afternoon), a role's id in the ledger and on an agent (manager, member, viewer; admin), a pull request's state (open, merged, closed). A number the page passes bare ("{banned} banned") takes a plural of its own, so one reads "1 bloqueada".

| English | Spanish |
|---|---|
| issue | incidencia |
| project | proyecto |
| board | tablero |
| sprint | sprint |
| backlog | backlog |
| help desk | servicio de asistencia |
| request (help desk) | solicitud |
| requester | solicitante, la persona solicitante |
| copied on a request (CC), copy, stop copying | en copia, poner en copia, quitar de la copia |
| customer group | grupo de clientes |
| reporter | informante; "quien la notificó" in a sentence |
| report (an issue), reported | notificar, notificada |
| assignee | responsable |
| agent | agente |
| workflow | flujo de trabajo |
| rule | regla |
| state machine | máquina de estados |
| transition | transición |
| knowledge base | base de conocimientos |
| article | artículo |
| inbox | bandeja de entrada |
| notification | notificación |
| digest | resumen |
| subscription, subscribe | suscripción, suscribirse |
| watch, watchers | seguir, quienes la siguen |
| timesheet | hoja de horas |
| work logged, log time | trabajo registrado, registrar tiempo |
| estimate | estimación |
| days away | ausencias |
| levelling | nivelación |
| slack (in a plan) | holgura |
| booked (in a plan) | asignado: "Horas asignadas", "quién tiene trabajo asignado" |
| what-if | hipótesis; the button is "¿Y si…?" |
| baseline | línea base |
| earned value | valor ganado |
| triage | clasificación |
| suggestion | sugerencia |
| token | token |
| allow (an app), apps you allowed | autorizar, "Aplicaciones que autorizaste" (one doesn't *permitir* an app) |
| two-factor sign-in | verificación en dos pasos |
| sign in, sign out | iniciar sesión, cerrar sesión |
| identity provider | proveedor de identidad |
| single sign-on | inicio de sesión único |
| webhook, delivery | webhook, entrega |
| post (a4a or a provider sending to an address) | enviar; *publicar* is for chat messages and comments |
| secret | secreto |
| commit, pull request, branch | commit, pull request (la), rama |
| build (CI) | compilación |
| field, value | campo, valor |
| link (between issues), unlink | enlace, enlazar; quitar el enlace (not *desenlazar*) |
| link, unlink (a chat account) | vincular, desvincular |
| resolve, resolved | resolver, resuelta |
| dashboard, widget | panel, widget |
| report | informe |
| role: administrator, manager, member, viewer | administrador, gestor, miembro, lector |

To check Spanish: the checks above; `e2e/spanish.spec.ts`, which signs a person of its own in through a Spanish browser and shoots the issues, an issue, the inbox, the profile and the sign-in page in light, in dark and at 390px; and a read of the pages in a browser that asks for Spanish.
## Japanese

`ja.json`, as Japanese teams read a tracker:

- **The polite form (です・ます) in sentences**: 「保存しました。」, 「先に保存してください。」. Buttons and labels are short nouns or verb phrases, never sentences: 「保存」, 「変更を保存」, 「フィールドを削除」.
- **No honorific after a name**: a name takes its particle directly (「Adaが割り当てました」), since many names are agents' and bots'. The help desk's emails are the one exception: they go to people outside the team, so they address a requester as 「{name}様」, as Japanese customer mail does.
- **Full-width punctuation**: 、。：（）, and 「」 for quotes. The ellipsis is one character (…), as in English. No space between Japanese and a Latin word or a value: 「BACK-12を開く」.
- **Plurals**: Japanese has none, so each plural keeps `other` alone, with a counter word: `{n, plural, other {#件の課題}}`. 件 counts issues and things, 人 people, 個 fields, values, files and tokens, 回 times.
- **Pieces a page joins**:
  - The activity ledger, an issue's history and notifications show who in bold, then what was done. So an action is a verb phrase in the polite past, with no subject: 「{issue}を変更しました」, 「報告しました」. A badge is a noun: 「課題の削除」.
  - A webhook's events are joined into 「{join}とき」 with 「、または」, so each is a clause in the plain past: 「課題が作成された」.
  - A rule is one sentence, in Japanese order: its trigger and conditions are clauses, its actions are verbs in the plain form, and the rule's words in `<t0>` are the particles that join them. 「課題が作成された<t0>とき</t0>、Type: Bugに一致する<t0>場合</t0>は、Assignee annaを適用する。」
- **A loading line is a whole message**, one per thing (`loadingLine.*`): 「計画を読み込み中…」. It names the thing with を and no owner (「受信トレイを読み込み中…」 for "Loading your inbox…"); a thing's own name or id reads 「{name}を読み込み中…」, and nothing, 「読み込み中…」.
- **Selects and plurals the English doesn't need**: a message keeps every placeholder English has. Where Japanese says nothing for one, it sits in a plural or select whose only branch is an empty `other`: `{n, plural, other {}}`. A plural that English words differently for one keeps `=1` where Japanese does too: `{n, plural, =1 {課題} other {#件の課題}}`.
- **Dates and numbers** come from Intl: 「2026年11月16日」, 「1,234.5」, 「3分前」.
- **Field names, states and values** are data, as in every language: the field panel says STATE and PRIORITY as they were named.
- **Selects on codes**: where English selects on a stable code (a pull request's `merged`, a unit's `points`, a role's `admin`, a report's `week`, a rule part's `trigger`), each case is worded in Japanese and every case stays: `{state, select, merged {マージ} closed {クローズ} other {再オープン}}`. A field's `{type}` in a problem is such a code too (`enum` 選択リスト, `owned` 担当者付きリスト), with `other` keeping the code.
- **Problems**: what a page shows when something fails says the problem, then its fix, in です・ます. Free text from elsewhere (a parser's message, another tracker's own words, a script's refusal) ends the Japanese message, after 「エラー：」, 「理由：」 or 「応答：」, and brings its own punctuation, so no 。 follows it: 「…もう一度お試しください。エラー：{error}」. A problem held in another's values (`{problems}`, `{reasons}`, a parser's `{problem}`) is said whole in Japanese, each sentence with its 。, and Japanese joins them with no gap, so it stays where English puts it: 「…のクエリに問題があります：{problems}クエリを修正するか…」. In the query, command and rule problems, the languages' keywords and fields' names stay as typed (`for: me`, `#Unresolved`, `sort by`, `State`), and a rule's choices are said as the rule form names them (「親課題」, 「1時間ごと」).
- **You and your**: a label that names the reader's own things says 自分の (「自分のトークン」, 「自分のダッシュボード」, 「自分のリクエスト」), or nothing where the owner is plain (「プロフィール」, 「タイマー」). あなた stays where the reader must be told from someone else: 「あなたとして動作します」, 「あなたではなく{login}として」.
- **The help desk** says 問い合わせ for asking for help: 「問い合わせました」 in an issue's history and notifications, 「お問い合わせ」 on the form and the portal. Its emails to requesters are a company's to a customer: 「{desk}にお問い合わせいただいたため、このメールをお送りしています。」

| English | Japanese |
|---|---|
| issue | 課題 |
| summary (an issue's title) | 件名 |
| description | 説明 |
| project | プロジェクト |
| board | ボード |
| sprint | スプリント |
| committed (a sprint's commitment) | コミットメント |
| blocker | ブロッカー |
| backlog | バックログ |
| help desk | ヘルプデスク |
| SLA at risk, breached | 要注意, 違反 |
| request (help desk) | リクエスト |
| requester | 依頼者 |
| copied on a request (CC), copy, stop copying | CC, CCに追加, CCから外す |
| customer group | 顧客グループ |
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
| what-if (in a plan) | シミュレーション (仮定 is "things a4a assumed") |
| baseline | ベースライン |
| earned value | アーンドバリュー（EV） |
| triage | トリアージ |
| suggestion | 提案 |
| token, revoke | トークン, 無効化 |
| fingerprint (of a token) | フィンガープリント |
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
## French

French (`fr.json`) is complete, written for France and Canada alike: no word only one of them uses ("e-mail", read in both, rather than "courriel" or "mail").

- **Vous**, always: "Enregistrez d'abord", "Votre profil". Never "tu".
- **Buttons are infinitives**: "Enregistrer", "Annuler", "Supprimer le champ". A status line is a past participle or a short sentence: "Enregistré.", "Enregistrement…".
- **Gender**: a4a never guesses a person's, and nothing agrees with the reader or the actor: "{who} vous mentionne" (not "vous a mentionné·e"), "Commenté par {them}", "vos abonnements" (not "vous êtes abonné"), "en accès invité" (not "en tant qu'invité"). A person is "la personne", "qui…", "toute personne qui…"; no "·e" endings, which screen readers read badly. The built-in roles are words for anyone: **Admin**, **Gestionnaire**, **Membre**, **Lecture seule**, **Accès invité**; in a sentence a role follows "le rôle", bare ("{name} a maintenant le rôle membre").
- **Counts**: French's "one" takes in 0 ("0 ticket"), so a message that says "un" or "une" for one takes `=1` beside it: "{n, plural, =1 {Pour le ticket} other {Pour # tickets}}". A participle that agrees with a number the message doesn't count is left out or turned: "bannis : {banned}", "Enregistré : {formatPeriod} sur {issue}".
- **Codes, not words**: where a message depends on a kind of thing, the page passes a stable code and the message selects on it, so French words each case whole: a pull request's `{state, select, merged {fusionnée} closed {fermée} …}`, a report's `{interval, select, day {jour} …}`, a sprint's unit, a rule's part, and whom a rule tells, `{who, select, assignee {son responsable} reporter {la personne qui l'a signalé} other {les personnes qui le suivent}}`. A role in a sentence is a select too: `{role, select, admin {Admin} member {Membre} viewer {Lecture seule} guest {Accès invité} other {{role}}}`.
- **Free text at a sentence's end** (`{message}`, `{said}`, `{problem}`) brings its own full stop: add none after it. Where a date ends a sentence, French ends it otherwise, since its short dates end in a point ("nov."): "{name} est déjà indisponible du {from} au {to} : modifiez plutôt cette absence".
- **Typography, as France sets it**: a no-break space (U+00A0) before ":", a narrow one (U+202F) before ";", "?" and "!" and inside « », and ’ for the apostrophe. The catalog holds those characters, so edit it with them. A plain ' before "{" would quote the brace in ICU; ’ never does.
- **Accents on capitals**: État, À, Échec.
- **What a page loads**: each loading line is a whole message (`loadingLine.*`), "Chargement" with its "de": "Chargement du planning…", "Chargement des agents…", "Chargement de vos abonnements…", "Chargement des absences de {name}…".
- **Data stays as named**, field names included where English gives them as examples: "State et Assignee seulement", "Won't fix exige un commentaire". Examples of the query and command languages stay as they are; examples of plain words for the assistant to read are French ("mettez-les en revue et assignez-les à anna").
- **The code hosts' own settings** are named as those products show them: Settings, Webhooks, Add webhook.

| English | French |
|---|---|
| issue | ticket |
| project | projet |
| board | tableau |
| sprint | sprint |
| backlog | backlog |
| help desk | centre d'assistance; after "à", "l'assistance de {project}" |
| request (help desk) | demande |
| requester | la personne qui a fait la demande; "Demandé par" in a table |
| copied on a request (CC), copy, stop copying | en copie, mettre en copie, retirer de la copie |
| customer group | groupe de clients |
| reporter | la personne qui l'a signalé; "Signalé par" in a table |
| assignee | responsable |
| lead (of a project) | responsable du projet |
| agent | agent |
| workflow | workflow |
| rule | règle |
| state machine | machine à états |
| transition | transition |
| knowledge base | base de connaissances |
| article | article |
| inbox | boîte de réception |
| notification | notification |
| digest | récapitulatif |
| subscription, subscribe | abonnement, s'abonner |
| watch, watcher | suivre, "Suivi par" |
| timesheet | feuille de temps |
| work logged, log time | temps saisi, saisir du temps |
| estimate | estimation |
| days away, away | absences, indisponible |
| levelling | nivellement |
| slack (in a plan) | marge |
| booked (hours in a plan) | planifié: "heures planifiées", never "réservé" |
| critical path | chemin critique |
| baseline | référence |
| earned value | valeur acquise |
| what-if | simulation |
| milestone | jalon |
| triage | triage (never "tri", which is French for a sort: "triés par") |
| suggestion | suggestion |
| tag | étiquette |
| token | jeton |
| scope (of a token) | portée: "la portée admin" |
| not found | introuvable, after the thing: "Ticket {id} introuvable."; a person's account is "Compte … introuvable" |
| two-factor sign-in | authentification à deux facteurs |
| sign in, sign out | se connecter, se déconnecter |
| login (the name) | identifiant |
| identity provider | fournisseur d'identité |
| single sign-on | authentification unique |
| webhook, delivery | webhook, envoi |
| secret | secret |
| commit, pull request, branch | commit, pull request, branche |
| field, value | champ, valeur |
| link (between issues) | lien |
| unlink | supprimer le lien (issues); dissocier (a chat account) |
| duplicate | doublon |
| resolve, resolved | résoudre, résolu |
| dashboard, widget | tableau de bord, widget |
| report | rapport |
| settings | paramètres |
| app | application |
| handler (of an app) | gestionnaire |

**Checking French.** The checks above, then `e2e/french.spec.ts`: a person of its own signs in through a French browser, and the issues, an issue, the inbox, the profile and a problem on the sign-in page are shot in light, in dark and at 390px. A reviewer who reads French walks the same pages and the emails (`server.*` keys), and reads each prefix's pieces together, as they join: the ledger (`activity.ledgerEntry.*`), a rule's sentence (`rules.words.*`) and the notification titles (`server.notify.*`).

## Indonesian

`id.json`, in the Indonesian of Indonesia's offices and software teams: standard spelling (KBBI and EYD), plain, and polite without ceremony.

- **Anda**, always, with its capital, as Indonesian software addresses its reader: "Anda belum punya token.", "Pilih proyek Anda". Never "kamu", "kau" or "-mu". "Silakan" is for where English says "please", where something is asked of someone.
- **Buttons and labels are short verb phrases or nouns**, never sentences: "Simpan", "Simpan perubahan", "Hapus bidang", "Batal". An instruction is the plain imperative, without "-lah" or "mohon": "Pilih proyek", "Ketik namanya".
- **Status lines are passive**: "Tersimpan.", "{name} ditambahkan.", "Dihapus."; what is under way is the active form, with the ellipsis: "Menyimpan…", "Mengirim…".
- **Verbs carry no tense.** A line whose place says it happened (the history, a notification) needs no "telah" or "sudah": "mengubah status". "Sudah" is English's "already", "masih" its "still", "belum" its "not yet", and "akan" its "will".
- **Pronouns have no gender**: "dia", "ia" and "-nya" are anyone's, so a4a never guesses a person's. "-nya" also stands for a thing ("mengubahnya"); where it could be read as either, the sentence names the thing.
- **Typography**: sentence case, as English's; quotation marks “…”, ‘…’ inside them; the one-character ellipsis (…); no space before ":", "?" or "!". An Indonesian prefix on an English word takes a hyphen, as EYD writes it ("di-merge"), and an Indonesian verb is taken where there is one ("diunggah", not "di-upload").
- **Plurals**: Indonesian doesn't inflect for number, and doesn't double a noun after a number or a word of quantity ("3 isu", "semua isu", "beberapa komentar"; never "3 isu-isu"), so each plural keeps `other` alone: `{n, plural, other {# isu}}`. Where English words none or exactly one apart and Indonesian does too, `=0` or `=1` stays beside it: `{n, plural, =0 {Tidak ada isu} other {# isu}}`. A noun without a number is the same for one or many: "Isu" heads the page of them.
- **Pieces a page joins**:
  - The activity ledger, an issue's history and notifications show who, in bold, then what was done. So an action is an active verb phrase, with its meN- prefix and no subject: "membuat {issue}", "mengomentari", "melaporkan", "menugaskannya kepada Anda". A ledger's badge says what its kind of event does, the same way and as English's do: "berkomentar", "menghapus isu".
  - A webhook's events are joined into "Ketika {join}", with Intl's "atau", so each is a passive clause: "isu dibuat", "komentar ditambahkan".
  - A rule is one sentence, in English's order, which Indonesian shares: its trigger and conditions are clauses, its actions are imperatives, and the words in `<t0>` are "Saat", "jika" and "maka": "<t0>Saat</t0> isu dibuat, <t0>jika</t0> cocok dengan Type: Bug, <t0>maka</t0> terapkan Assignee anna".
  - A loading line is a whole message, one per thing (`loadingLine.*`): "Memuat" and the thing, "Memuat rencana…", "Memuat permintaan Anda…", "Memuat {name}…", and "Memuat…" where nothing is named.
- **Selects and plurals the Indonesian doesn't need**: a message keeps every placeholder English has. Where Indonesian says nothing for one, it sits in a plural or select whose only branch is an empty `other`: `{n, plural, other {}}`. Where English selects on a code (a pull request's `merged`, a unit's `points`, a role's `admin`, a report's `week`), each case is whole Indonesian, and `other` keeps the code where English's does.
- **Problems** say what went wrong, then the fix, each a plain sentence: "Nama pengguna atau kata sandi salah.", "Nama itu sudah dipakai. Pilih nama lain." Free text from elsewhere (another tracker's words, a script's refusal, a parser's message) stays where English puts it and brings its own full stop. In the query, command and rule problems, the languages' keywords and the fields' names stay as typed (`for: me`, `#Unresolved`, `sort by`, `State`).
- **You and your**: "Anda" after what it owns, where the owner must be told ("Token Anda", "Permintaan Anda"), and nothing where it's plain: a page's heading is "Profil", not "Profil Anda".
- **The help desk** is for people outside the team: they send a "permintaan", and are its "pemohon". Its emails and its portal are a company's words to its customers: "Anda", courteous and plain, with no "Yth." or "Bapak/Ibu", since a4a doesn't know who reads them.
- **Data stays as named**: projects, fields and their values, states and tags, inside Indonesian sentences too ("Won't fix memerlukan komentar"). Examples of the query and command languages stay as they are; examples of plain words for the assistant to read are Indonesian.
- **Dates and numbers** come from Intl, as Indonesia writes them: "16 Nov 2026", "14.05", "1.234,5", "3 menit yang lalu", and lists "A, B, dan C". Intl reads `id` as `id-ID`, so a4a passes it as it is.

Indonesian teams mostly read their trackers in English, and this catalog found no Indonesian Jira or YouTrack to lean on. So the trackers' own words stay as those teams say them (sprint, backlog, commit, pull request, branch, build, webhook, token, widget), and the everyday ones are those Indonesian software has settled, Google's and Microsoft's: Simpan, Batal, Masuk, Keluar, Pengaturan, Kotak masuk, Notifikasi, Dasbor, Unggah, Unduh.

| English | Indonesian |
|---|---|
| issue | isu |
| summary (an issue's title) | ringkasan |
| description | deskripsi |
| project | proyek |
| lead (of a project) | pemimpin proyek |
| board | papan |
| sprint | sprint |
| committed (a sprint's commitment) | komitmen |
| blocker | penghambat |
| backlog | backlog |
| help desk | layanan bantuan |
| SLA at risk, breached | berisiko, terlampaui |
| request (help desk) | permintaan |
| requester | pemohon |
| copied on a request (CC), copy, stop copying | penerima tembusan, tambahkan ke tembusan, hapus dari tembusan |
| customer group, kept from the group | grup pelanggan, dirahasiakan dari grup |
| reporter | pelapor |
| report (an issue), reported | melaporkan, dilaporkan |
| assignee, assign | penerima tugas, tugaskan |
| agent | agen |
| assistant (its name), the assistant | assistant, asisten |
| conversation (with the assistant) | percakapan |
| workflow | alur kerja |
| rule | aturan |
| if (a rule's or a transition's condition) | jika, after a trigger's "Saat" |
| state machine | mesin status |
| state | status |
| transition | transisi |
| knowledge base | basis pengetahuan |
| article | artikel |
| inbox | kotak masuk |
| notification | notifikasi |
| digest | ikhtisar |
| subscription, subscribe | langganan, berlangganan |
| watch, watcher | pantau, pemantau |
| timesheet | lembar waktu |
| work logged, log time | waktu tercatat, catat waktu |
| estimate | estimasi |
| rate (per hour) | tarif per jam |
| days away, away | ketidakhadiran, tidak hadir |
| levelling | perataan beban |
| slack (in a plan) | kelonggaran |
| booked (hours in a plan) | dialokasikan: "jam yang dialokasikan" |
| critical path | jalur kritis |
| milestone | milestone |
| baseline | baseline |
| earned value | nilai hasil (EV) |
| cost and schedule performance (CPI, SPI) | kinerja biaya, kinerja jadwal |
| what-if | simulasi |
| triage | triase |
| suggestion | saran |
| tag | tag |
| token, revoke | token, cabut |
| fingerprint (of a token) | sidik jari |
| scope (of a token) | cakupan |
| not found | tidak ditemukan, after the thing: "Isu {id} tidak ditemukan." |
| two-factor sign-in | autentikasi dua faktor |
| sign in, sign out | masuk, keluar |
| login (a person's handle) | nama pengguna |
| identity provider | penyedia identitas |
| single sign-on | single sign-on (SSO) |
| webhook, delivery | webhook, pengiriman |
| post (a4a or a provider sending to an address) | mengirim |
| secret | secret, as the code hosts' forms name it |
| commit, pull request, branch | commit, pull request, branch |
| merge, merged | merge, di-merge |
| build (CI), CI | build, CI |
| field, value | bidang, nilai |
| link (between issues), unlink | tautan, tautkan; hapus tautan |
| link, unlink (a chat account) | hubungkan, putuskan |
| duplicate | duplikat |
| resolve, resolved, resolution | selesaikan, selesai, penyelesaian |
| dashboard, widget | dasbor, widget |
| report | laporan |
| settings | pengaturan |
| app, handler (of an app) | aplikasi, penangan |
| allow (an app), apps you allowed | izinkan, "Aplikasi yang Anda izinkan" |
| person, people | orang (counted: "3 orang"), pengguna (accounts) |
| role, permission | peran, izin |
| administrator, manager, member, viewer, guest | administrator, manajer, anggota, pelihat, tamu |

**Why isu for issue**: it is the word Indonesian developers already say, in KBBI's spelling, and it covers a bug, a task and a request alike. "Masalah" is a problem, which a feature request isn't; "tiket" reads as a help desk's or a train's; "tugas" is a task, one kind of issue among others.

**Checking Indonesian**: the checks above, then `e2e/indonesian.spec.ts`: a person of its own signs in through an Indonesian browser, and the issues, an issue, the inbox, the profile and a problem on the sign-in page are shot in light, in dark and at 390px. A reviewer who reads Indonesian walks the same pages and the emails (`server.*` keys), and reads each prefix's pieces together, as they join: the ledger (`activity.ledgerEntry.*`), an issue's history (`issues.issueHistory.*`), a rule's sentence (`rules.words.*`) and the notification titles (`server.notify.*`).
