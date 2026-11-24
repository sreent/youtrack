# Translating a4a

a4a speaks to each person in their own language (D49 in [architecture.md](architecture.md)). English is the source; German, Spanish, Japanese, French, Korean, Portuguese (Portugal's), Simplified Chinese, Vietnamese, Indonesian and Thai are complete. This page says how a4a sounds in each language, the words each chose for a4a's terms, how to check a language, and how to add one.

## What is translated, and what isn't

Translated: every word the web app says (pages, buttons, labels, empty states, problems, the names screen readers read), and what a4a sends people: emails, the inbox's titles, push notifications, and chat: the bot's replies and its cards' words. The bot's commands (`help`, `new`, `search`, `subscribe`) are the same in every language, as the command language's are.

Not translated:

- **What people named**: projects, fields and their values, states, tags, link types, saved searches, rules, boards. `State`, `Priority`, `In Progress` and `Won't fix` are data, so a query or a command says them as they were named.
- **The query and command languages**: `project: BACK #Unresolved for: me` and `State Fixed` read the same everywhere. Examples of them in a page's words stay as they are.
- **The API's and MCP's own words**: what `/api/v1` answers and what the MCP tools say are for programs and agents, in English. A problem carries a key and values beside its English, so a page says it in its person's language.

## The catalogs

One file per language in `packages/shared/i18n/`, named by its code: `en.json`, `de.json`, `pt.json` and the rest. Each holds every message as [ICU MessageFormat](https://unicode-org.github.io/icu/userguide/format_parse/messages/), keyed by what it is for and where: `page.profile.language`, `issues.commandBar.noChange`, `server.notify.title.assigned`, `problem.wrongLogin`.

- `{name}` is a value a4a puts in. Keep every one English has, spelled the same, and add none.
- `{n, plural, one {# Vorgang} other {# Vorgänge}}` chooses by number; `#` is the number as Intl writes it in the language ("1.234").
- `<t0>…</t0>` is a link or emphasis around words: keep it around the words that mean the same.
- A leading or trailing space in English is there because the message sits beside another: keep it where your language puts a space there. Japanese and Chinese, which don't space their words, mostly drop it.
- `'{'` writes a brace, and `''` an apostrophe before one.

Messages are whole sentences where English could make them so, but some are pieces a page puts together: "{who} {did}" in an email, "an issue is created" after "When". The key's prefix says where a piece goes; read the pieces of one prefix together.

What the code gives a message is never English words to choose by:

- **Counts are the message's own plural.** "Apply to {n, plural, one {# issue} other {# issues}}": inflect the noun as the sentence needs ("von # Vorgängen"), and agree the verb with it.
- **Choices are codes.** `{who, select, you {…} other {…}}` (you, or a person by `{name}`), `{target, select, resolution {…} other {…}}`, `{joined, select, yes {…} other {…}}`: word each option in your language; `other` takes whatever else comes.
- **Lists come joined** by the language's own list (Intl.ListFormat: `formatList` on a page, `joinList` on the server): "A, B und C", "A、B、C", or with "or" where any one will do, as a webhook's events are ("A, B oder C"). Don't add "and" or "or" around a `{join}`, `{actions}` or `{states}`. Things a page shows one after another, with no "and", take the comma the language puts between a list's first items (`formatItems`): "BACK-1, BACK-2", 「BACK-1、BACK-2」. Some lists inside the server's problems (the `{values}` a field allows, the `{ids}` a command can't find) still come joined with English's ", ".
- **Quotes are the language's.** Where a page quotes a name or words inside a sentence (a saved search, an app on the consent page, a command the assistant runs), it quotes them with `ui.quoted`: give it your language's marks („…“, « … », 「…」, «…»), and add none around a value that comes quoted.
- **A role is its name alone** outside English, "ist jetzt {role}": English alone adds "a" or "an". A built-in role's name is a message (`roles.builtin.*`); one people made stays as named. A sentence with a role in it says which it is, `{named, select, yes {…} other {…}}`, so a language that sets a name off and joins its own words can do each: Thai's “คุณเป็นสมาชิก” beside “คุณเป็น Auditor”, Chinese's 「是成员」 beside 「是 Auditor」.
- **A rule is one sentence** per kind (`rules.words.whenSentence`, `rules.words.scheduleSentence`): put its parts in your order.
- **Sizes and numbers** come from Intl ("12,3 MB", "12,3 Mo"), never from the catalog. A size, a count or a status code is a value inside its message, never put beside it: "{n, plural, one {# file ({size})} …}", "delivered, {code}", 「已送达（{code}）」.
- **A value that may be a name or a4a's own words is a select.** Where a page would pass either project keys or "no project yet", a field's name or "no build field yet", it passes which it is beside the name: `{scope, select, all {Runs in every project.} none {Runs in no project yet.} other {Runs in {projects}.}}`. Word each case whole.
- **One message serves one use.** A column's head and the legend over checkboxes, a date a column maps to and a count in a tally, an expiry choice and the "Last used" column, a confirm for a field and one for a value: each is a message of its own, worded for its place (French deletes a field with "Le supprimer" and a value with "La supprimer"). A webhook's event is two: the clause that follows "When" in a sentence (`page.webhooks.anIssueIsCreated`, "ein Vorgang angelegt wird") and its checkbox's label on the form (`page.webhooks.label.issueCreated`, "Vorgang angelegt"). An import's problems have two sets of badges: a dry run's, which say what would happen (`imports.mappingTable.wouldNotBeImported`, "Wouldn't be imported"), and a finished import's (`imports.mappingTable.notImported`, "Not imported"); its tally's "Not imported" is a message of its own (`imports.mappingTable.notImportedTally`).
- **A time in a sentence** (`{when}`, `changed {when}`) is a relative one ("3 minutes ago", "vor 3 Minuten"), or after a week a day, with the words `ui.badges.onDate` puts before it ("on 16 Nov", "am 16. Nov."; Japanese's, Korean's, Chinese's and Thai's take it bare). Word the sentence so both read: German's "geändert {when}", not "zuletzt geändert: {when}". Under 45 seconds it's `ui.badges.justNow`, which goes where a relative time goes, so it's worded as one where the language's particles need it: Japanese's 「数秒前」 takes 「に」 as 「3 分前」 does (「数秒前に追加」, where 「たった今に」 can't be said), Korean's 「몇 초 전」 takes 「에」, and Thai's 「ไม่กี่วินาทีที่แล้ว」 follows 「เมื่อ」.
- **A control's name holds the words it shows.** Where a button or a link shows a few words and a screen reader hears a longer name, its `…For`, `…Of` or `…To` message ("Remove passkeys of {name}" for "Remove passkeys"), the name keeps the shown words whole and in order, so someone who says what they see reaches it (WCAG 2.5.3): "Passkeys entfernen für {name}", not "Passkeys für {name} entfernen"; 「为 {name} 移除通行密钥」, not 「移除 {name} 的通行密钥」. Where the language's order would split them, the shown words come first and what they act on follows, after a colon if need be: "นำออกจากกลุ่ม: {email}". `check:words` checks it in every language.

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
| passkey | Passkey (der Passkey, die Passkeys) |
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
| whiteboard; a note, card, section, arrow, an arrow's label, the outline | Whiteboard (das), Notiz, Karte, Bereich, Pfeil, Beschriftung, Gliederung |
| connect (draw an arrow), make issues (of notes) | verbinden; Vorgänge anlegen |
| a note's tones: plain, idea, agreed, question, problem, parked | Neutral, Idee, Vereinbart, Frage, Problem, Zurückgestellt |
| writing help; where an issue came from (a chat message) | Schreibhilfe; Herkunft |

## Checking a language

1. `pnpm --filter @a4a/web check:words` (also in `pnpm test`): every catalog has every English key and no other, every message parses, each has English's placeholders and tags, every key the code says is in English, every English key is said somewhere, no words sit in JSX, in a label map, or in what the server sends people, and a control's name holds the words it shows, in every language.
2. `pnpm --filter @a4a/server exec vitest run test/translation.test.ts`: a query's words and its count in each language, an email in each recipient's language, the language on `/me`, a problem's key, and Korean's particles.
3. The browser: `pnpm test:e2e german.spec.ts` (the README's [End-to-end tests](../README.md#end-to-end-tests) section says what it needs). `e2e/german.spec.ts` takes a German browser through the issues, an issue, the inbox, the profile, a project's people, a query's problem, a rule's preview and the sign-in page, shoots each in light, in dark and at 390px, and fails if a page spills sideways there. Its shots are in the HTML report (`apps/web/playwright-report`), which CI writes and keeps when a run fails, and `--reporter=html` writes locally. The suite's tour (`e2e/tour.spec.ts`) walks every page, in English.
4. Read it. Set your profile's language, or your browser's, and walk the pages you know: the inbox, an issue's history, the plan, a rule's sentence, an email (a test server's `SMTP_URL` to a catcher), the help desk's pages signed out. A message that reads wrong in its place is a piece read on its own: find its key with the words beside it, and its prefix's neighbours.
5. Settle what's left open. No native speaker has read German, Spanish, French, Japanese, Korean, Portuguese, Simplified Chinese, Vietnamese, Indonesian or Thai yet. German, Spanish, French and Japanese have had a second reader; Simplified Chinese, Korean, Vietnamese, Indonesian and Thai have had two rounds by an editor who read them for what gives a translation away, the pages people see most read whole and the rest swept for its patterns, and Portuguese was rewritten whole as Portugal's. [translation-questions.md](translation-questions.md) lists, by language, the choices their reviews and edits couldn't settle.

## Adding a language

A language is a catalog and a few lines of code:

1. In `packages/shared/src/i18n.ts`, add the code to `LOCALES`, its own name to `LOCALE_NAMES` as its readers write it ("Italiano", "Português"), and what goes between two of its sentences to `SENTENCE_GAP`: a space, or nothing after a 。 as in Japanese and Chinese. Where its country, calendar or digits matter, give its tag in `langTag` (the page's `lang`) or `intlTag` (its dates, numbers, plurals and lists), as Portuguese's `pt-PT` and Thai's `th-TH-u-ca-gregory-nu-latn` are.
2. Copy `packages/shared/i18n/en.json` to `<code>.json` and translate every message.
3. In `packages/server/src/i18n.ts`, import the catalog and add it to `catalogs` beside the others (the server's catalogs are imported, not globbed). In `packages/server/src/ai/writing.ts`, add the language's English name to `LANGUAGE`, as the writing help's prompt names it.
4. If it lowers a common noun's capital inside a sentence, as English, Spanish, French, Indonesian, Portuguese and Vietnamese do, add it to `LOWERS_LABELS` in `apps/web/src/i18n/index.ts`: a label set in its sentences then begins in lower case. Leave it out if its nouns keep their capital, as German's do, or it has no case, like Chinese, Japanese, Korean and Thai: a name or an acronym that begins a label there keeps its capital.
5. Write its voice and its terms here, in a section of its own, add its code to `DEFAULT_LOCALE`'s values in the README, then run the checks above. A copy of `e2e/indonesian.spec.ts` with the language's words checks it in a browser. It signs in a person of its own, not one of the suite's administrators, since German's spec changes Una's language, and it saves its shots beside each test in `apps/web/test-results`.

The web finds a new catalog by itself, and loads only its person's. A right-to-left language would also need `dir="rtl"` on the page and Ocean's layouts checked (D49 says what holds).

## Spanish

One Spanish for Spain and Latin America: no *vosotros*, and no word only one side uses. Where the two differ, the catalog takes the form most Spanish speakers use and every reader knows: *agregar* (not *añadir*), *costo* (not *coste*), *correo* for email, *PC* where English says computer, *informe* for a report.

- **Tú**, always: "Elige un proyecto", "Tu perfil". Spanish software, Jira's and Slack's among them, says *tú* to its people on both sides of the Atlantic; *usted* reads as a form letter there. German's *Sie* is German's own convention.
- **Buttons are infinitives**: "Guardar", "Guardar los cambios", "Eliminar el campo". Instructions and help are the *tú* imperative: "Elige", "Escribe", "Pulsa".
- **What just happened is the present perfect**: "Se ha guardado.", "Se ha creado {name}.". History and notifications, which carry their time, are the preterite: "la movió", "comentó", "te la asignó".
- **An issue is *incidencia***, feminine, so what refers to one agrees with it: "la notificó", "Notificada por", "resuelta".
- **Gender**: a4a doesn't guess a person's. It says "la persona", "quien…", "quienes la siguen", and takes nouns that don't change: *responsable* (assignee), *solicitante* (requester), *informante*, *agente*, *miembro*. Where a person's gender would show in an adjective, the sentence turns: "Ya no tienes suscripción a…", not "Ya no estás suscrito". Roles stay as their words, as German's do: *administrador*, *gestor*, *miembro*, *lector*. A role's bare name follows a singular: "{name} es ahora {role}"; after a plural it is "tienen al menos el rol {role}". A guest is "con acceso de invitado", never "como invitado".
- **Typography**: opening ¿ and ¡. Quotation marks are “…”, as English's are (« » is Spain's print habit, not Latin America's). A space before % and before a unit: "50 %", "30 s". The ellipsis is one character.
- **Dates and numbers** come from Intl: "16 nov 2026", "1234,5" and "12.345,5" (Spanish groups from five digits), "hace 3 minutos".
- **Codes are selects**, as German's are: each case is whole Spanish, and `other` takes whatever else comes: a report's `{interval}` (day, week, month) and `{by}` (column, state), a Gantt bar's `{part}` (morning, afternoon), a role's id on an agent and in a token's problem (admin, member, viewer, guest), a pull request's `{state}` (merged, closed, reopened, declined, open). A number the page passes bare ("{banned} banned") takes a plural of its own, so one reads "1 bloqueada".

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
| passkey | llave de acceso |
| sign in, sign out | iniciar sesión, cerrar sesión |
| identity provider | proveedor de identidad |
| single sign-on | inicio de sesión único |
| webhook, delivery | webhook, entrega |
| post (a4a or a provider sending to an address) | enviar; *publicar* is for chat messages and comments |
| request (HTTP) | solicitud |
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
| whiteboard; a note, card, section, arrow, an arrow's label, the outline | pizarra, nota, tarjeta, sección, flecha, etiqueta, esquema |
| connect (draw an arrow), make issues (of notes) | conectar; crear incidencias |
| a note's tones: plain, idea, agreed, question, problem, parked | Normal, Idea, Acordada, Pregunta, Problema, Aplazada |
| writing help; where an issue came from (a chat message) | ayuda para escribir; de dónde viene |

To check Spanish: the checks above; `e2e/spanish.spec.ts`, which signs a person of its own in through a Spanish browser and shoots the issues, an issue, the inbox, the profile and the sign-in page in light, in dark and at 390px; and a read of the pages in a browser that asks for Spanish.

## Japanese

`ja.json`, as Japanese teams read a tracker:

- **The polite form (です・ます) in sentences**: 「保存しました。」, 「先に保存してください。」. Buttons and labels are short nouns or verb phrases, never sentences: 「保存」, 「変更を保存」, 「フィールドを削除」.
- **No honorific after a name**: a name takes its particle directly (「Adaがあなたに割り当てました」), since many names are agents' and bots'. The help desk's emails are the one exception: they go to people outside the team, so they address a requester as 「{name}様」, as Japanese customer mail does.
- **Full-width punctuation**: 、。：（）, and 「」 for quotes. The ellipsis is one character (…), as in English. No space between Japanese and a Latin word or a value: 「BACK-12を開く」.
- **Plurals**: Japanese has none, so each plural keeps `other` alone, with a counter word: `{n, plural, other {#件の課題}}`. 件 counts issues and things, 人 people, 個 fields, values, files and tokens, 回 times.
- **Pieces a page joins**:
  - The activity ledger, an issue's history and notifications show who in bold, then what was done. So an action is a verb phrase in the polite past, with no subject: 「{issue}を変更しました」, 「報告しました」. A badge is a noun: 「課題の削除」.
  - A webhook's events are joined into 「{join}とき」 by Intl's "or" list (「AまたはB」, 「A、B、またはC」), so each is a clause in the plain past: 「課題が作成された」. The same clauses label the form's checkboxes (`page.webhooks.label.*`).
  - A rule is one sentence, in Japanese order: its trigger and conditions are clauses, its actions are verbs in the plain form, and the rule's words in `<t0>` are the particles that join them. 「課題が作成された<t0>とき</t0>、Type: Bugに一致する<t0>場合</t0>は、Assignee annaを適用する。」
- **A loading line is a whole message**, one per thing (`loadingLine.*`): 「計画を読み込み中…」. It names the thing with を and no owner (「受信トレイを読み込み中…」 for "Loading your inbox…"); a thing's own name or id reads 「{name}を読み込み中…」, and nothing, 「読み込み中…」.
- **Selects and plurals the English doesn't need**: a message keeps every placeholder English has. Where Japanese says nothing for one, it sits in a plural or select whose only branch is an empty `other`: `{n, plural, other {}}`. A plural that English words differently for one keeps `=1` where Japanese does too: `{n, plural, =1 {課題} other {#件の課題}}`.
- **Dates and numbers** come from Intl: 「2026年11月16日」, 「1,234.5」, 「3 分前」.
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
| passkey | パスキー |
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
| whiteboard; a note, card, section, arrow, an arrow's label, the outline | ホワイトボード・付箋・カード・セクション・矢印・ラベル・アウトライン |
| connect (draw an arrow), make issues (of notes) | 矢印でつなぐ; 課題にする |
| a note's tones: plain, idea, agreed, question, problem, parked | 標準・アイデア・合意済み・質問・問題・保留 |
| writing help; where an issue came from (a chat message) | 文章作成サポート; 作成元 |

**Why 課題 for issue**: it's what Jira's and Backlog's Japanese say, so Japanese teams already read trackers in it. チケット (Redmine's) reads as a support ticket, and イシュー, GitHub's loanword, is stiff in a sentence.

**Checking Japanese**: the checks above, and `e2e/japanese.spec.ts`. It signs a person of its own in, through the sign-in page of a Japanese browser, and opens the issues, an issue, the inbox and the profile. It also shows a problem on the sign-in page. It shoots each page in light, in dark and at 390px, into the HTML report and beside the test in `apps/web/test-results`.

A reader of Japanese can then:

- read those shots;
- set a profile's language to 日本語 and walk the pages;
- read the pieces of one prefix together, since a page joins them: `activity.ledgerEntry.*`, `issues.issueHistory.*`, `server.notify.*`, `rules.words.*`.

The shots in this repository's container use its only CJK font, WenQuanYi Zen Hei, a Chinese font, which sets kana in full-width cells. They look looser than on a machine with a Japanese font, so judge spacing with Noto Sans JP or Hiragino.

## French

French (`fr.json`) is complete, written for France and Canada alike: no word only one of them uses ("e-mail", read in both, rather than "courriel" or "mail").

- **Vous**, always: "Enregistrez d’abord", "Votre profil". Never "tu".
- **Buttons are infinitives**: "Enregistrer", "Annuler", "Supprimer le champ". A status line is a past participle or a short sentence: "Enregistré.", "Enregistrement…".
- **Gender**: a4a never guesses a person's, and nothing agrees with the reader or the actor: "{who} vous mentionne" (not "vous a mentionné·e"), "Commenté par {them}", "vos abonnements" (not "vous êtes abonné"), "en accès invité" (not "en tant qu’invité"). A person is "la personne", "qui…", "toute personne qui…"; no "·e" endings, which screen readers read badly. The built-in roles are words for anyone: **Admin**, **Gestionnaire**, **Membre**, **Lecture seule**, **Accès invité**; in a sentence a role follows "le rôle", bare ("{name} a maintenant le rôle membre").
- **Counts**: French's "one" takes in 0 ("0 ticket"), so a message that says "un" or "une" for one takes `=1` beside it: "{n, plural, =1 {Pour le ticket} other {Pour # tickets}}". A participle that agrees with a number the message doesn't count is left out or turned: "bannis : {banned}", "Enregistré : {formatPeriod} sur {issue}".
- **What's asked for takes the subjunctive**: a relative clause saying what a thing asked for must do is "Demandez … un rôle qui le permette", "donnez à a4a un jeton qui puisse lire le dépôt", "Choisissez une personne qui puisse modifier ses tickets". A label that only describes keeps the indicative: "Un jeton d’accès qui peut écrire des statuts de commit".
- **Codes, not words**: where a message depends on a kind of thing, the page passes a stable code and the message selects on it, so French words each case whole: a pull request's `{state, select, merged {fusionnée} closed {fermée} …}`, a report's `{interval, select, day {jour} …}`, a sprint's unit, a rule's part, and whom a rule tells, `{who, select, assignee {son responsable} reporter {la personne qui l’a signalé} other {les personnes qui le suivent}}`. A role in a sentence is a select too: `{role, select, admin {Admin} member {Membre} viewer {Lecture seule} guest {Accès invité} other {{role}}}`.
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
| help desk | centre d’assistance; after "à", "l’assistance de {project}" |
| request (help desk) | demande |
| requester | la personne qui a fait la demande; "Demandé par" in a table; several are "les personnes qui font des demandes", and a heading names the portal, where only they sign in: "Connexion au portail", "Fournisseurs d’identité du portail" |
| copied on a request (CC), copy, stop copying | en copie, mettre en copie, retirer de la copie |
| customer group | groupe de clients |
| reporter | la personne qui l’a signalé; "Signalé par" in a table |
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
| subscription, subscribe | abonnement, s’abonner |
| watch, watcher | suivre, "Suivi par" |
| timesheet; submit, approve, send back (a week) | feuille de temps (never "semaine de temps"); soumettre, approuver, rouvrir |
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
| scope (of a token) | étendue: "l’étendue admin", as GitHub's and Microsoft's French docs say; Slack's own stay "scopes", as its English-only app settings say |
| not found | introuvable, after the thing: "Ticket {id} introuvable."; a person's account is "Compte … introuvable" |
| two-factor sign-in | authentification à deux facteurs |
| passkey | clé d’accès |
| sign in, sign out | se connecter, se déconnecter |
| login (the name) | identifiant |
| identity provider | fournisseur d’identité |
| single sign-on | authentification unique |
| webhook, delivery | webhook, envoi |
| secret | secret |
| commit, pull request, branch | commit, pull request, branche |
| declined (a pull request) | refusée |
| check run, check (GitHub's) | exécution de vérification, vérification, as GitHub's French docs say; the app's permission keeps GitHub's label, "Checks : Read and write" |
| commit status (GitLab's, Forgejo's) | statut de commit, as GitLab's French docs say |
| field, value | champ, valeur |
| link (between issues) | lien |
| unlink | supprimer le lien (issues); dissocier (a chat account) |
| duplicate | doublon |
| resolve, resolved | résoudre, résolu |
| dashboard, widget | tableau de bord, widget |
| report | rapport |
| settings | paramètres |
| app | application |
| package (of an app) | paquet |
| manager (the role); handler (of an app) | Gestionnaire, Google's word for the role; gestionnaire, the French for a handler. A page that shows both names the projects: "les gestionnaires des projets" |
| administrator | admin: "un admin", "les admins", the role's own name and a word for anyone, where "administrateur" isn't |
| attachment, attach | fichier joint (they're listed under "Fichiers"), joindre; never "pièce jointe" |
| upload | envoyer, l’envoi; never "téléverser", which France doesn't say |
| choose (things to act on: a list's checkboxes, the canvas) | sélectionner, as Windows, macOS and Gmail do: "Sélectionner BACK-1", "Tout désélectionner" |
| email domain | domaine de messagerie |
| ways to sign in | façons de se connecter |
| FIDO's metadata, the FIDO Alliance | les métadonnées FIDO, le BLOB FIDO; l’Alliance FIDO |
| homeserver, room (Matrix) | serveur d’accueil, salon, as Element says |
| whiteboard; a note, card, section, arrow, an arrow's label, the outline | tableau blanc (never "tableau" alone, which is a board), note, carte, section, flèche, libellé, plan (Word's and Google Docs' word for an outline; a4a's plan is "planning") |
| connect (draw an arrow), make issues (of notes) | relier; créer des tickets |
| a note's tones: plain, idea, agreed, question, problem, parked | Neutre, Idée, Décision, Question, Problème, En attente ("Validée" would say someone approved it) |
| writing help; where an issue came from (a chat message) | aide à la rédaction; provenance |

**Checking French.** The checks above, then `e2e/french.spec.ts`: a person of its own signs in through a French browser, and the issues, an issue, the inbox, the profile and a problem on the sign-in page are shot in light, in dark and at 390px. A reviewer who reads French walks the same pages and the emails (`server.*` keys), and reads each prefix's pieces together, as they join: the ledger (`activity.ledgerEntry.*`), a rule's sentence (`rules.words.*`) and the notification titles (`server.notify.*`).

## Portuguese

`pt.json` is Portugal's Portuguese, as Microsoft's and Google's interfaces in Portugal write it, spelled by the 1990 agreement as Portugal applies it (*facto*, *contacto*, *receção*, *secção*, *ação*). Its code is `pt`, and Intl and the page's `lang` are `pt-PT`. Where Portugal's software has its own word for a thing, a4a takes it: *ficheiro*, *ecrã*, *utilizador*, *equipa*, *palavra-passe*, *guardar*, *eliminar*, *partilhar*, *transferir*, *carregar* (upload), *iniciar sessão*, *terminar sessão*, *definições*, *aplicação*, *registar*, *telemóvel*, *browser*, *separador*.

- **No você.** Portugal's software leaves the reader to the verb: "Pode convidar as outras pessoas depois", "Não tem permissão para fazer isto", "Recebeu este e-mail porque…", "Quis dizer «{guess}»?". Instructions are the third-person imperative: "Introduza", "Selecione", "Indique", "Inicie sessão", "Tente novamente". Where the reader is the object, *lhe* or *si*, which choose no gender: "{who} atribuiu-lhe o item", "{who} fez-lhe uma menção", "itens atribuídos a si", "Também tem acesso". *Você* stays only where the code hands the reader in as a name, and only there: "{who} aplicou" with *Você* (`decide.suggestionCard.you`), the portal's own messages ("<t0>Você</t0> escreveu", `page.track.youAsked`), and "me" in a query's explanation (`server.query.you`, which stands both after a preposition and alone).
- **A possessive takes its article, and only where it's needed**: "o seu pedido", "as suas subscrições", "Os seus pedidos" beside a group's, but "Perfil", "A carregar a caixa de entrada…", "E-mail", "Nome". A label that names the reader's own thing says it bare when nothing else is near: "Temporizador", not "O seu temporizador".
- **Buttons are infinitives**, without an article: "Guardar", "Cancelar", "Guardar alterações", "Eliminar campo", "Iniciar sessão", "Mudar o nome", "Enviar teste". A status line is a participle, or "a" + infinitive while it goes on: "Guardado.", "A guardar…", "Palavra-passe alterada.". An optional field says so in brackets: "Comentário (opcional)".
- **The progressive is "a" + infinitive**: "A importação está a ler os itens", "continuam a chegar", "o assistente está a trabalhar…". No status line is a bare gerund; a gerund that says how ("avise a equipa respondendo a um e-mail", "desfazendo a ação de um agente") is Portugal's too. A run under way is *em execução*, and what's ongoing *em curso*.
- **Clitics follow the verb** in an affirmative sentence ("Guarde-o", "Atualize-a", "Verifique-os", "{who} atribuiu-lhe o item"), and come before it after a negation, *que*, *quem*, *porque*, *já*, *só*, *também*, *nenhum*, *alguém* and the like ("não o mostra", "só quem o gere", "porque o item lhe foi atribuído", "Nenhum campo aqui se chama…"); after a preposition, before the infinitive ("para o mover", "para a configurar"). No mesoclisis: the future is "vai" + infinitive, or the present.
- **Portugal's phrases**, where it has one: "Algo correu mal", "Tente novamente daqui a 2 minutos" (*daqui a*, not *em*), "Demasiados pedidos em pouco tempo", "já não" (never "não… mais"), "tem de" and "precisar de", "Mudou de ideias?", "Sem comentários.", "Seguinte", "Largue ficheiros aqui", "num", "numa", "noutro". An empty state is "Ainda não há regras.". A day in a sentence takes *a*: "Reportado por Ana a {date}", "Enviada por {author} a {when}". A server or a service is reached with *ligar-se a* or *aceder a*; a connection is a *ligação*.
- **"It" is named**: where English says "it" or "its" for something the message hasn't named (a rule, a webhook, an import, a script, an app), Portuguese names it, "A regra ainda não agiu.", "O webhook está em pausa…", or, in a label that lists what something does, leaves it to the verb: "Pede para", "Executa um script". A message doesn't begin with "Ele" or "Ela" pointing back.
- **Choosing** issues in a list or elements on a whiteboard is *selecionar*: "Selecionar todos os 12 itens", "3 selecionados", "Limpar seleção". *Escolher* is for picking one option among several: "Escolha um projeto".
- **What just happened** is the *pretérito perfeito*: "O token {name} foi revogado.", "{title} foi instalada.", and, where a4a speaks as "we", "Enviámos" with Portugal's accent, apart from the present "enviamos". History and notifications, which carry their time, say it the same way: "comentou", "atribuiu-lhe o item".
- **An issue is *item***, masculine: "o item", "Reportado por", "resolvido", "item criado". *Tarefa* stays free for the Task type people name, and the assistant's summary of an issue is a *resumo*, so an issue's summary is its *título*.
- **Gender**: a4a doesn't guess a person's, and nothing agrees with the reader or the actor. Where Portuguese lets a sentence avoid it, it does: "quem fez o pedido", "a pessoa responsável", "quem reportou o item", "as pessoas que acompanham", "Este pedido só é visível para si e para a equipa"; and where a name is missing, the bare noun: "Requerente". Nouns that don't change are welcome: *responsável*, *requerente*, *agente*, *membro*, *líder*. A participle about the reader or a person named turns into a verb or a noun: "Sessão iniciada como {name}" (not "conectado"), "Já não subscreve {name}" (not "inscrito"), "recebeu uma menção" (not "foi mencionado"). Roles stay as their words, as German's and Spanish's do: *administrador*, *gestor*, *membro*, *leitor*, *convidado*; in a sentence a role follows "a função de", "{name} tem agora a função de {role}", "Aqui, a sua função é {role}", and a guest is "com acesso de convidado". Where a list marks the reader among people, it says "(eu)": "Ana (eu)". Whoever must act is "um administrador": "Peça a um administrador que lhe dê acesso."
- **Typography**: quotation marks are «…», and “…” inside them, as Portugal's print and the EU's Portuguese style write them; straight quotes stay where a command is typed (`subscribe "My bugs"`). The ellipsis is one character (…). No space before ":", "?", ";" or "%" ("50%"), a space before a unit ("30 s", "3,5 h"). Sentence case in headings, labels and buttons; weekdays and months are lower case, as Intl writes them. "e-mail", with its hyphen; "online"; *o* URL.
- **Counts**: Portugal's rule (CLDR's for `pt-PT`): `one` is 1 alone, so 0 is plural, "0 itens", as English's is. A message that says "um" or "uma" for one says it in `one`: `{n, plural, one {um item} other {# itens}}`; `=1` is kept only where English has one beside `one` (`{n, plural, =1 {} =2 { duas vezes} other { # vezes}}`). A number the page passes bare ("{banned} banned") takes a plural of its own. A participle that would agree with a number turns: "bloqueados: {banned}". The issue list's count line puts the count last ("Itens no projeto SPR, não resolvidos: 4"), since its "resolvidos" and "ordenados" agree with the issues, not the count.
- **Pieces a page joins**:
  - The activity ledger, an issue's history and notifications show who in bold, then what was done. So an action is a verb phrase in the *pretérito perfeito*, with no subject: "criou {issue}", "comentou em {issue}", "reportou o item e atribuiu-lho". A verb that needs an object names the issue, "moveu o item de BACK para WEB", "reportou o item"; one that doesn't drops English's "on it": "registou tempo". The channel after the action is "pela web", "pelo chat", "pela API", and a tool or platform by its name "via {name}" ("via GitHub", "via Slack, como Ana"). A badge is a lower-case noun, as English's is lower case: "eliminação de item". A title that counts several people's changes puts the count first, so its verb needn't agree: "2 alterações de Anna e Ben".
  - A webhook's events are joined into "Quando {join}" by Intl's "or" list ("A, B ou C"), each a clause in the present: "um item é criado", "um comentário é eliminado", "alguém comenta". The same clauses, with a capital, label the form's checkboxes (`page.webhooks.label.*`): "Um item é criado".
  - A rule is one sentence: "Quando um item é criado, se corresponder a Type: Bug, então aplicar Assignee anna." Its trigger is the same clause as a webhook's event, its conditions follow "se", and its actions are infinitives after "então"; the rule's own words in `<t0>` are the words that join them.
  - **A loading line is a whole message**, one per thing (`loadingLine.*`), "A carregar" and its article: "A carregar o plano…", "A carregar os agentes…", "A carregar {name}…", and "A carregar…" when nothing is named.
  - **A date in a sentence** may be a day or a part of one ("sexta, 4/12", "a manhã de sexta, 4/12"), so a sentence takes it after *para* or *a*, or in brackets, never after a preposition that would need to contract with it: "Ausência adicionada para {whenWords}: …".
- **Selects on codes**: where English selects on a stable code (a pull request's `merged`, a unit's `points`, a role's `admin`, a report's `week`, a rule part's `trigger`), each case is worded whole in Portuguese, with its own article and agreement, and every case stays: `{state, select, merged {integrado} closed {fechado} other {aberto}}`. Where English says nothing for a value, Portuguese keeps it in an empty branch, as Japanese does: `{n, plural, other {}}`.
- **Problems** say what went wrong, then the fix, in the imperative: "Nome de utilizador ou palavra-passe incorretos.", "Este quadro não usa sprints. Ative os sprints no quadro primeiro." Something not found is the thing, then *não encontrado*: "Item {id} não encontrado. Use um ID legível, como BACK-12." Free text from elsewhere (`{message}`, `{error}`, a parser's `{problem}`, another tracker's words) brings its own full stop: none follows it. In the query, command and rule problems, the languages' keywords and fields' names stay as typed (`for: me`, `#Unresolved`, `State`, `tag urgent`).
- **The help desk** is the *centro de apoio*, as Portugal's companies name where their customers ask for help; a request is a *pedido* (an HTTP request is a *pedido* too, and the context tells them apart), and whoever asks is the *requerente*, "quem fez o pedido" in a sentence. Its emails to requesters are a company's to a customer: "Recebeu este e-mail porque pediu ajuda ao {desk}. Para responder, basta responder a este e-mail…". A desk's name comes without its article (`server.helpdesk.deskOf`, "centro de apoio de {project}"), so each sentence contracts it: *ao*, *no*, *do*. The portal is the *portal*, and the link a customer signs in with is a *link de acesso*, which "só pode ser usado uma vez e é válido durante 20 minutos".
- **Data stays as named**, field names included where English gives them as examples ("Só State e Assignee"), and so does a field a page falls back on by name (a report's Priority and State); examples of the query and command languages stay as they are, and examples of plain words for the assistant to read are Portuguese. A time zone given as an example is Portugal's: Europe/Lisbon.
- **Dates and numbers** come from Intl (`pt-PT`), never from the catalog: "4/12/2026", "sexta, 4/12", "1234,5", "12 345,5", "há 3 minutos".

| English | Portuguese |
|---|---|
| issue | item, masculine: "o item", "os itens" (see below) |
| summary (an issue's title) | título |
| description | descrição |
| project | projeto |
| lead (of a project) | líder do projeto |
| board | quadro |
| sprint | sprint, masculine: "o sprint", "um sprint", as Portugal's teams say it |
| committed (a sprint's commitment) | comprometido |
| goal (a sprint's) | objetivo |
| blocker | impedimento |
| backlog | backlog |
| help desk | centro de apoio |
| SLA at risk, breached | em risco, violado |
| request (help desk; HTTP) | pedido |
| requester | requerente; "quem fez o pedido" in a sentence |
| sign-in link (the portal's, for a customer) | link de acesso |
| copied on a request (CC), copy, stop copying | em cópia (CC), pôr em cópia, tirar da cópia |
| customer group, kept from the group | grupo de clientes, oculto do grupo |
| reporter, report (an issue), reported | quem reportou, reportar, "Reportado por" |
| assignee | responsável; "a pessoa responsável" in a sentence |
| agent | agente |
| assistant (its name), the assistant | assistente, o assistente |
| conversation (with the assistant) | conversa |
| workflow | fluxo de trabalho; a CI's own (GitHub Actions') stays *workflow* |
| rule | regra |
| if (a rule's or a transition's condition) | se |
| state machine | máquina de estados |
| transition | transição |
| state | estado |
| knowledge base | base de conhecimento |
| article | artigo |
| inbox | caixa de entrada |
| notification | notificação |
| digest | resumo diário |
| subscription, subscribe, unsubscribe | subscrição, subscrever, cancelar a subscrição |
| watch, watcher | acompanhar, "quem acompanha" |
| timesheet | folha de horas |
| work logged, log time, work item | trabalho registado, registar tempo, registo de trabalho |
| timer | temporizador |
| estimate | estimativa |
| rate (per hour) | valor por hora |
| days away, away, sick, training | ausências, ausente, baixa médica, formação |
| levelling | nivelamento |
| slack (in a plan) | folga |
| booked (hours in a plan) | alocado: "horas alocadas" |
| critical path | caminho crítico |
| baseline | linha de base |
| earned value, earned | valor ganho (VG), ganho, as Portugal's project managers say it; the other figures keep their abbreviations: VP, CR, IDC, IDP, VC, VPR, ONT, ENT, EPT, VNT |
| cost and schedule performance (CPI, SPI) | desempenho de custo e de prazo (IDC, IDP) |
| milestone | marco |
| what-if | simulação; the button is "E se…" |
| triage | triagem |
| suggestion | sugestão |
| tag | etiqueta; the command language's `tag` stays |
| token, revoke | token, revogar |
| scope (of a token) | âmbito: "o âmbito admin" |
| fingerprint (of a token) | impressão digital |
| not found | não encontrado, after the thing: "Item {id} não encontrado." |
| two-factor sign-in | verificação em dois passos |
| sign in, sign out, signed in | iniciar sessão, terminar sessão, com sessão iniciada; "o início de sessão" |
| login (a person's handle) | nome de utilizador |
| user, password | utilizador, palavra-passe |
| identity provider | fornecedor de identidade |
| provisioning (SCIM), tenant | aprovisionamento, inquilino (Microsoft's Portuguese) |
| single sign-on | início de sessão único (SSO); "SSO" where a sentence already says *iniciar sessão* |
| webhook, delivery | webhook, entrega |
| post (a4a or a provider sending to an address) | enviar; *publicar* is for chat messages and comments |
| secret | segredo |
| commit, pull request, branch | commit, pull request, branch ("o commit", "o pull request", "o branch") |
| merge, merged | integrar, integrado |
| CI, build | CI, build ("o build") |
| field, value | campo, valor |
| default | predefinição, predefinido |
| choose, chosen (issues in a list, elements on a whiteboard) | selecionar, selecionado: "3 selecionados", "Limpar seleção"; *escolher* for one option among several |
| link (between issues), unlink | ligação, ligar; remover a ligação |
| link, unlink (a chat account) | associar, desassociar |
| link (a commit or a pull request to an issue) | associar: "associou o pull request #12" |
| connect, disconnect (an account, a workspace, a server) | ligar, desligar; *ligar-se a* a server |
| link (a URL) | link |
| duplicate | duplicado |
| resolve, resolved, resolution | resolver, resolvido, resolução |
| dashboard, widget | painel, widget |
| report | relatório |
| settings | definições; *configurar* for setting a thing up |
| file, upload, download | ficheiro, carregar, transferir |
| save, delete, share, rename | guardar, eliminar, partilhar, mudar o nome |
| app, allow (an app), apps you allowed | aplicação ("a aplicação"), autorizar, "Aplicações que autorizou"; a GitHub App by its name |
| handler (of an app) | handler |
| person, people, team | pessoa, pessoas, equipa |
| role, permission | função, permissão (as Microsoft's and Google's Portuguese say a role) |
| administrator, manager, member, viewer, guest | administrador, gestor, membro, leitor, convidado |
| whiteboard; a note, card, section, arrow, an arrow's label, the outline | quadro branco, never shortened, since *quadro* is a board; nota, cartão, secção, seta, rótulo, estrutura |
| connect (draw an arrow), make issues (of notes) | ligar; criar itens |
| a note's tones: plain, idea, agreed, question, problem, parked | Simples, Ideia, Acordada, Pergunta, Problema, Em espera |
| writing help; where an issue came from (a chat message) | ajuda na escrita; origem |
| browser, tab, screen, phone | browser, separador, ecrã, telemóvel |

**Why *item* for issue**: it's what Portuguese teams read in a tracker, in Jira (whose only Portuguese is Brazil's: "Criar item", "Tipo de item") and in Azure DevOps ("itens de trabalho"), and it's short enough for a badge. *Problema* would collide with a4a's problems and a note's tone, *tarefa* with the Task type, *questão* reads as a question, *ocorrência* as a service desk's incident, and *issue*, said in many teams, is English.

**Checking Portuguese**: the checks above, and `e2e/portuguese.spec.ts`. It signs a person of its own in through the sign-in page of a browser in Portugal (`pt-PT`), and opens the issues, an issue, the inbox and the profile; it also shows a problem on the sign-in page to a browser in Brazil (`pt-BR`), which gets Portugal's Portuguese too, with `lang="pt-PT"`. It shoots each page in light, in dark and at 390px, into the HTML report and beside the test in `apps/web/test-results`. A reviewer who reads Portuguese walks the same pages and the emails (`server.*` keys), and reads each prefix's pieces together, as they join: the ledger (`activity.ledgerEntry.*`), an issue's history (`issues.issueHistory.*`), a rule's sentence (`rules.words.*`) and the notification titles (`server.notify.*`).

## Korean

`ko.json`, Korean as South Korea writes it, as Korean teams read a tracker. Where a tracker's Korean is settled, it's Jira's, which most Korean teams have worked in: 이슈, 담당자, 보고자, 요약, 해결, 전환, 하위 작업. Where Jira's Korean and what developers say part (GitHub's Korean says 끌어오기 요청 and 웹후크), the catalog takes what developers say: 풀 리퀘스트, 웹훅.

- **합니다체 in sentences**: "저장했습니다.", "이슈 {id}이(가) 없거나 볼 수 없습니다." What a sentence asks of the reader is "-세요", as Korean software asks it, beside 합니다체: "먼저 저장하세요.", "다시 시도하세요." "-십시오" reads as an official notice, and 해요체 ("저장했어요") as a chat app's.
- **Buttons and labels** are short nouns or verb phrases, never sentences: "저장", "변경 사항 저장", "필드 삭제", "취소". A status line is a short sentence: "저장했습니다.", "저장하는 중…".
- **A particle after a value** depends on how the value ends. So the catalog writes it both ways, consonant's first, as Korean software writes it: 을(를), 이(가), 은(는), 과(와), (으)로, (이)나, (이)라는. "{name}을(를) 삭제했습니다.", "{field}이(가) 필수입니다." a4a then chooses the one the value needs wherever it can hear the value's end: after Hangul, by its last syllable's final consonant, and after a digit, as Korean reads it ("BACK-12를", "민준이", "서울로", "이슈 3개를"; `koreanParticles`). After a Latin word ("Anna을(를)") both ways stay. After a4a's own words, whose end is known, write the one it needs: "로그인 ID를", "콜론(:)이", "닫는 괄호 “)”가". Where a value is itself a message of the catalog's (the sign-in form's name, "a4a 계정"), let it end in the catalog's Hangul, so a4a hears it: "a4a 계정을 사용하세요". A field set or cleared on a board is its value ("Priority 값을 지웁니다"), and a column is named with 열 ("Done 열로"), as Korean says them. This is the one way: a sentence isn't reworded to dodge one. The subject's is 이(가), not (이)가, since it's 이 or 가, never 이가. A value followed by a noun ("{key} 프로젝트") needs none, nor one that never changes (에, 에서, 의, 도, 만, 까지, 부터, 에게).
- **No honorific after a name**: a name takes its particle directly ("{who}이(가) 나에게 할당했습니다"), since many names are agents' and bots'. The help desk's emails are the one exception: they go to people outside the team, so they address a requester as "{name}님", as Korean customer mail does.
- **Spacing**, as Korean writes it: words apart, a particle or an ending joined to its word, a counter joined to its digits ("3개", "이슈 3개"). A particle joins a value or a Latin word directly: "{id}을(를) 다른 프로젝트로 이동".
- **Typography**: ASCII punctuation, . , : ? !, with no space before it; “” for quotes, and straight ones only where they're code (a JSON key, a form part's name, a chat command's argument); the ellipsis is one character (…), as in English; half-width Latin letters and digits, never full-width forms. Two sentences said one after the other take a space between them.
- **Two clauses are two sentences, or one joined by a connective**, never English's colon: "꺼져 있어 아무것도 하지 않습니다.", "삭제되었을 수 있으니 헬프데스크 설정을 다시 불러오세요.", "연결을 해제했습니다. 이제부터 그 계정의 커밋은 내 것이 아닙니다." A colon follows a label or a status ("역할: 관리자", "꺼짐:", "일시 중지됨:"), an example ("예: acme.com") or the lead of a list, and comes before free text from elsewhere ("오류:"). A menu path is written with ">": "Asana의 My settings > Apps > Manage developer apps".
- **Plurals**: Korean has none, so each plural keeps `other` alone, with a counter where Korean uses one, after the noun: `{n, plural, other {이슈 #개}}`. 개 counts issues and things (fields, values, files, tokens), 건 cases and events (changes, requests, deliveries, notifications), 명 people, 번 times. A plural that English words differently for one keeps `=1` where Korean does too.
- **Pieces a page joins**:
  - The activity ledger, an issue's history and notifications show who in bold, with their mark, then what was done. A name a page draws can't take a particle, so an action is a verb phrase in the polite past with no subject: "{issue}을(를) 변경했습니다", "보고했습니다". A badge is a noun: "이슈 삭제".
  - A webhook's events are nouns, joined into "{join} 시" by Intl's "or" list (" 또는 "): "이슈 생성 또는 댓글 작성 시". The same nouns label the form's checkboxes (`page.webhooks.label.*`).
  - A rule is one sentence, in Korean order: its trigger is a clause before the rule's word for when, its conditions a clause before its word for if, and its actions are nouns, as a rule's summary lists them; the rule's words in `<t0>` are those that join them. "이슈가 생성될 <t0>때</t0>, Type: Bug에 일치<t0>하면</t0>, Assignee anna 적용."
- **A loading line is a whole message**, one per thing (`loadingLine.*`): "계획을 불러오는 중…". It names the thing with 을(를) and no owner ("수신함을 불러오는 중…" for "Loading your inbox…"); a thing's own name or id reads "{name}을(를) 불러오는 중…", and nothing, "불러오는 중…".
- **Selects and plurals the Korean doesn't need**: a message keeps every placeholder English has. Where Korean says nothing for one, it sits in a plural or select whose only branch is an empty `other`: `{n, plural, other {}}`.
- **Selects on codes**: where English selects on a stable code (a pull request's `merged`, a unit's `points`, a role's `admin`, a report's `week`, a rule part's `trigger`), each case is worded in Korean and every case stays, `other` keeping what else comes.
- **Dates and numbers** come from Intl: "2026년 11월 16일", "1,234.5", "3분 전". Intl's `ko` writes them as `ko-KR` does.
- **Problems**: what a page shows when something fails says what went wrong, then the fix, in 합니다체 with the fix in "-세요": "로그인 ID 또는 비밀번호가 올바르지 않습니다." A guess it offers is "혹시 “{guess}”인가요?". Free text from elsewhere (a parser's message, another tracker's own words, a script's refusal) ends the Korean message, after "오류:", "이유:" or "응답:", and brings its own punctuation, so no full stop follows it. A problem held in another's values (`{problems}`, `{reasons}`) is said whole, each sentence with its full stop, and stays where English puts it. In the query, command and rule problems, the languages' keywords and fields' names stay as typed (`for: me`, `#Unresolved`, `State`).
- **You and your**: Korean software rarely says "you". A label that names the reader's own things says 내 ("내 토큰", "내 대시보드", "내 요청"), or nothing where the owner is plain ("프로필", "타이머"); a sentence leaves the reader out ("이슈 {id}이(가) 없거나 볼 수 없습니다."), and a query's, a list's or a notification's "you" is 나 ("나에게 할당됨", "Ada이(가) 나에게 할당했습니다"). 본인 stays where the reader must be told from someone else: "본인으로 동작합니다", "본인과 관리자, 입력한 사람만 볼 수 있습니다". 당신 is never said. Acting as the reader is "내 계정으로" ("내 계정으로 동작하는 Teams와 Slack 계정"), never "나로", which reads as the speaker, and a token acting as someone else is "내 계정이 아니라 {login} 계정으로"; an agent or a token acting as itself is "자체 계정으로", and one acting for someone "{name} 대신". The chat bot says 본인, since its "I" is a4a: "본인에게 할당했습니다". A name a4a can't show is "알 수 없는 사용자", not 누군가.
- **The help desk** says 문의 for asking for help: "문의했습니다" in an issue's history and notifications, "문의하기" on the form and the portal. Its emails to requesters are a company's to a customer: "{desk}에 문의하셔서 이 메일을 보내 드립니다." What its form, portal and request page ask of a customer is "-어 주세요" where Korean support writes it ("한 줄로 적어 주세요", "스팸함을 확인해 주세요"), still a -세요; "What do you need?" is "어떤 도움이 필요하신가요?".
- **An email's footer** says why it came as a sentence: each reason (`server.notify.because.*`) is a clause, and the footer ends it: "이슈를 지켜보고 있어서 받는 메일입니다." A stop link is "… 수신 중지".

| English | Korean |
|---|---|
| issue | 이슈 |
| summary (an issue's title) | 요약 |
| description | 설명 |
| comment | 댓글 |
| project | 프로젝트 |
| lead (of a project) | 프로젝트 리더 |
| board | 보드 |
| sprint | 스프린트 |
| committed (a sprint's commitment) | 확정 (커밋 is version control's) |
| blocker | 블로커 |
| backlog | 백로그 |
| subtask, parent | 하위 작업, 상위 이슈 |
| help desk | 헬프데스크 |
| SLA at risk, breached | 위험, 위반 |
| request (help desk) | 요청; asking for help is 문의 |
| requester | 요청자 |
| copied on a request (CC), copy, stop copying | 참조, 참조에 추가, 참조에서 제외 |
| customer group, kept from the group | 고객 그룹, 그룹에 비공개 |
| reporter | 보고자 |
| report (an issue), reported | 보고, 보고했습니다; "Reported by" is "보고자: {v}" |
| assignee | 담당자 |
| agent | 에이전트 |
| assistant (its name), the assistant | assistant, 어시스턴트 |
| conversation (with the assistant) | 대화 |
| workflow | 워크플로 |
| rule | 규칙 |
| if (a rule's or a transition's condition) | 조건; in a rule's sentence, "-(으)면" |
| state machine | 상태 머신 |
| transition | 전환 |
| state | 상태 |
| knowledge base | 지식 베이스 |
| article; bring a version back | 문서; 복원 |
| inbox | 수신함 |
| notification | 알림 |
| digest | 요약 메일 |
| subscription, subscribe | 구독, 구독하다 |
| watch, watcher | 지켜보기, 지켜보는 사람 |
| timesheet | 타임시트 |
| work logged, log time | 작업 기록, 시간 기록 |
| estimate | 추정치 |
| rate (per hour) | 시간당 단가 |
| days away, away | 부재일, 부재 중 |
| levelling | 평준화 |
| slack (in a plan) | 여유 시간 |
| booked (in a plan) | 배정: "배정된 시간" |
| critical path | 주 경로 |
| what-if (in a plan) | 가상 계획 |
| baseline | 기준선 |
| milestone | 마일스톤 |
| earned value, earned | 획득 가치(EV), 획득 |
| cost and schedule performance (CPI, SPI) | 원가 성과(CPI), 일정 성과(SPI) |
| triage | 트리아지 |
| suggestion | 제안 |
| tag | 태그 |
| token, revoke | 토큰, 폐기 |
| scope (of a token) | 범위 |
| fingerprint (of a token) | 지문 |
| not found | 찾을 수 없음: "이슈 {id}을(를) 찾을 수 없습니다." |
| two-factor sign-in | 2단계 인증 |
| sign in, sign out | 로그인, 로그아웃 |
| login (a person's handle) | 로그인 ID |
| a4a login, {name} login (the credentials a form takes) | a4a 계정, {name} 계정 |
| identity provider | ID 공급자 |
| single sign-on | SSO |
| webhook, delivery | 웹훅, 전송 |
| post (a4a or a provider sending to an address) | 보내다; 게시 is for chat messages and comments |
| secret | 시크릿 |
| commit, pull request, branch | 커밋, 풀 리퀘스트, 브랜치 |
| merge, merged | 병합, 병합됨 |
| CI, build | CI, 빌드 |
| field, value | 필드, 값 |
| link (between issues), unlink | 링크, 링크 해제 |
| link, unlink (a chat account) | 연결, 연결 해제 |
| duplicate | 중복 |
| resolve, resolved, resolution | 해결, 해결됨, 해결 |
| dashboard, widget | 대시보드, 위젯 |
| report | 보고서 |
| settings | 설정 |
| app, allow (an app), apps you allowed | 앱, 승인, 승인한 앱; revoking one is 승인 취소 |
| action (an issue's button) | 동작 |
| handler (of an app) | 핸들러 |
| person, people | 사용자; 사람 in a sentence |
| role, permission | 역할, 권한 |
| administrator, manager, member, viewer, guest | 관리자, 매니저, 멤버, 뷰어, 게스트 |
| whiteboard; a note, card, section, arrow, an arrow's label, the outline | 화이트보드, 메모, 카드, 섹션, 화살표, 레이블, 개요 |
| connect (draw an arrow), make issues (of notes) | 연결; 이슈로 만들기 |
| a note's tones: plain, idea, agreed, question, problem, parked | 기본, 아이디어, 합의됨, 질문, 문제, 보류 |
| writing help; where an issue came from (a chat message) | 글쓰기 도움; 출처 |

**Why 이슈 for issue**: it's what Jira's Korean and Korean developers say, so Korean teams already read trackers in it. 티켓 reads as a support ticket, and 과제 as homework or a funded project.

**Why 매니저 beside 관리자**: 관리자 is the administrator, as Korean software has it, so a project's manager is 매니저, as Google's and Slack's Korean give roles their loanwords (뷰어, 멤버).

**Checking Korean**: the checks above, and `e2e/korean.spec.ts`. It signs a person of its own in, through the sign-in page of a Korean browser, and opens the issues, an issue, the inbox and the profile. It also shows a problem on the sign-in page. It shoots each page in light, in dark and at 390px, into the HTML report and beside the test in `apps/web/test-results`.

A reader of Korean can then:

- read those shots;
- set a profile's language to 한국어 and walk the pages;
- read the pieces of one prefix together, since a page joins them: `activity.ledgerEntry.*`, `issues.issueHistory.*`, `server.notify.*`, `rules.words.*`, `page.webhooks.*`.

The shots in this repository's container use its only CJK font, WenQuanYi Zen Hei, a Chinese font with Hangul in it. Judge spacing and line breaks with Noto Sans KR, Apple SD Gothic Neo or Malgun Gothic.

## Simplified Chinese

`zh.json` is Simplified Chinese as mainland China writes it, in the words Chinese teams read a tracker in. Where Jira's Simplified Chinese has a word for a tracker's thing, a4a takes it (问题, 经办人, 报告人, 冲刺, 看板, 待办事项, 仪表板, 转换), since most teams there met a tracker through it.

- **你, not 您.** Chinese software for teams says 你 today: Feishu, DingTalk and WeCom, Notion's and Slack's Chinese, Microsoft's and Apple's. 您 is a bank's or a form letter's, and a4a speaks to a team plainly: 「你已离线」, 「你没有权限执行此操作。」. The help desk's words to requesters are the one exception: its emails, the portal and the public form speak to customers outside the team, so they say 您, as Chinese customer service does: 「您收到这封邮件，是因为您向“{desk}”提交了请求。」
- **请 where a sentence asks the reader to act**, as Chinese software asks: a problem's fix and a notice's request (「请稍后重试。」, 「请联系管理员。」, 「请先保存，之后才能插入图片和文件。」). A bare imperative after what went wrong reads as an order in Chinese, though English's has no "please". A sentence that only says how something works needs none (「保存前，系统按计划的工作日和你的可用工时计算。」), and one sentence asks with 请 once. Buttons and labels are short verb phrases or nouns, never sentences, and never 请: 「保存」, 「保存更改」, 「删除字段」, 「确认新密码」. A status line is short: 「已保存。」, 「正在保存……」, 「已创建 {name}。」
- **Name the thing; don't point back with 它, and say who did it rather than 被.** Where English says "it" or "this", Chinese names it again or leaves it out: 「把此问题指派给了你」, 「此文章位于 … 之下」, 「按钮会显示在适用的问题上」, not 「它的按钮…」. Where English uses the passive, Chinese says who acted: 「其他人已更改了 BACK-1」, 「有人刚刚删除了它」, 「可能刚刚有人把它从白板上移除了」. Passives Chinese itself says stay: 已被占用, 已被封禁, 被提及. 进行 goes where the verb says it: 「执行管理操作」, not 「进行管理」.
- **The owner goes where Chinese leaves it out**: 「使用 a4a 账号登录。」, 「主邮箱，a4a 会把邮件发到这里。」, 「代表 Ada 处理问题、看板和计划」. A person's is 其 or 此人, never 他们 for one person: 「其 GitHub 用户名。」
- **Typography, as mainland China sets it**:
  - full-width punctuation: ，。、：；？！（）;
  - quotes are “…”, and ‘…’ inside them (「」 is Taiwan's and Japan's);
  - the ellipsis is ……, two of …, as Chinese sets it: 「正在加载……」;
  - no space between Chinese characters;
  - **one half-width space where Chinese meets a Latin word or a digit**, on either side: 「在 GitHub 上」, 「3 个问题」, 「打开 {id}」, 「最近 {d} 天」. A placeholder is spaced as the name, id, number or date it holds: 「由 {name} 创建」, 「{n} 天」. One that holds a4a's own Chinese words (a built-in role's name, a piece of another message) joins without one. Never a space beside full-width punctuation: 「（{id}）」, 「：{name}」, 「“{name}”」;
  - a placeholder that holds a name or a4a's own words by turns (a tracker's name or 「文件」) goes after full-width punctuation where the sentence allows, so neither gets a stray space: 「来源：{from}」, 「{name} 将接收：{what}。」. Where the code says which a value is, the message selects on it and words each case whole: 「在所有项目中运行。」 and 「运行范围：BACK和WEB。」 (`apps.appsSection.runsIn`);
  - what Intl writes keeps its own spacing: 「2026年11月16日」, 「2.5小时」, 「3分钟前」;
  - " · " between the parts of a line, and code, ids, queries and keyboard keys stay as English writes them.
- **Plurals**: Chinese has none, so each plural keeps `other` alone, and counts with a measure word: `{n, plural, other {# 个问题}}`. 个 counts issues, projects, fields, values, files, tokens and most things; 人 people (「3 人」), and 位 before a noun (「2 位抄送人」); 项 items, changes and tasks; 条 comments, notifications, rules and messages; 篇 articles; 次 times, builds and deliveries; 天, 小时 and 分钟 are their own words. A plural English words differently for one keeps `=1` where Chinese does too: `{n, plural, =1 {该问题} other {# 个问题}}`.
- **Selects and plurals the English doesn't need**: a message keeps every placeholder English has. Where Chinese says nothing for one, it sits in a plural or select whose only branch is an empty `other`: `{n, plural, other {}}`.
- **Pieces a page joins**:
  - The activity ledger, an issue's history and notifications show who in bold, then what was done. So an action is a verb phrase with 了 and no subject: 「创建了 {issue}」, 「评论了 {issue}」, 「在分支 main 上提交了 abc1234」; a notification's names the issue, 「把此问题指派给了你」, 「删除了此问题」. A badge is a noun or a short verb phrase: 「新问题」, 「删除问题」.
  - A webhook's events are each an active clause, joined into 「{join}时」 by Intl's "or" list (或, with 、 before it in a longer list): 「创建问题或有人发表评论时」, 「从项目中移除成员时」. The same clauses label the form's checkboxes (`page.webhooks.label.*`).
  - A rule is one sentence, in Chinese order: 「<t0>当</t0>{trigger}<t0>时</t0>，<t0>如果</t0>问题匹配 {query}，<t0>则</t0>{actions}。」 Its trigger is a clause (「创建问题」, 「问题的 {field} 发生变更」), its conditions say 如果, and its actions are verb phrases (「应用 Assignee anna」, 「通知经办人“{short}”」). Issues it reaches by a link are 「通过“{phrase}”链接的问题」. The rule's words in `<t0>` are 当…时, 如果 and 则.
  - A time in a sentence goes before its verb, as Chinese says it: 「3分钟前更新」, 「11月16日报告」, 「3 个元素，3分钟前更改」, not 更新于 {when}. A clock time or a date from `whenRead` (「14:05」) keeps 更新于, so no digit touches a Chinese character.
- **A loading line is a whole message**, one per thing (`loadingLine.*`): 「正在加载计划……」. It names the thing with no owner (「正在加载收件箱……」 for "Loading your inbox…"); a thing's own name or id reads 「正在加载 {name}……」, and nothing, 「正在加载……」.
- **Dates and numbers** come from Intl, `zh`, which writes them as `zh-CN` does: 「2026年11月16日」, 「1,234.5」, 「3分钟前」, lists as 「A、B和C」.
- **Selects on codes**: where English selects on a stable code (a pull request's `merged`, a unit's `points`, a role's `admin`, a report's `week`, a rule part's `trigger`), each case is worded in Chinese and every case stays: `{state, select, merged {已合并} closed {已关闭} other {已重新打开}}`. A field's `{type}` in a problem is such a code too (`enum` 选项列表, `owned` 带负责人的列表), with `other` keeping the code.
- **Field names, states and values** are data, as in every language: 「State 和 Assignee」 stay as they were named, and so do examples of the query and command languages (`for: me`, `#Unresolved`). Examples of plain words for the assistant to read are Chinese.
- **Problems** say what went wrong, then ask for the fix: 「找不到问题 {id}。请使用可读的编号，例如 BACK-12。」 A parser's says what's missing or out of place, as Chinese tools do: 「“sort by”后面缺少“:”」, 「此处不应出现“)”」, 「没有名为“X”的字段。」 问题 is an issue here, never what went wrong: a problem says 无法…, 出错, 不能… or 有误. Free text from elsewhere (a parser's message, another tracker's words, a script's refusal) ends the message after 「错误：」, 「原因：」 or 「回复：」 and brings its own punctuation, so no 。 follows it. A problem held in another's values (`{problems}`, `{reasons}`) is said whole, each sentence with its 。, and Chinese joins them with no gap.
- **You and your**: a label that names the reader's own things says 我的, as Chinese apps' menus do (「我的令牌」, 「我的仪表板」, 「我的订阅」), or nothing where the owner is plain (「个人资料」). A sentence speaks to the reader as 你 and 你的: 「你的角色是只读的。」
- **The help desk** is 服务台, and asking it for help 提交请求: 「提交了请求」 in an issue's history, 「通过服务台提交了请求」 in a notification. Its pages and emails for requesters say 您.
- **A status and what follows from it** are two clauses, or two sentences, as Chinese software says them, not English's colon: 「已断开连接，从现在起该账号下的提交不再归你。」, 「我不在 #eng 中。请用 /invite @a4a 邀请我，然后重试。」 A colon stays where Chinese explains with one: 「这些是你的恢复码：……」.
- **Something that sends or takes deliveries** (a webhook, an integration, a build source) shows 已启用 or 已暂停, and its buttons say 暂停 and 重新启用.
- **Another product's screens** keep their English words, and a4a's steps say what to fill in, as Chinese docs do: 「Payload URL 填写上方的 URL」, 「打开 Settings 下的 Webhooks」. A path through menus is joined with >: 「在 Jira 中打开个人资料 > Personal Access Tokens」.

| English | Simplified Chinese |
|---|---|
| issue | 问题 |
| summary (an issue's title) | 概要 |
| description | 描述 |
| project | 项目 |
| lead (of a project) | 负责人 |
| board | 看板 |
| sprint | 冲刺 |
| committed (a sprint's commitment) | 承诺 |
| blocker | 阻碍; to block is 阻塞: 「是什么阻塞了 {issue}？」 |
| backlog | 待办事项 |
| help desk | 服务台 |
| SLA at risk, breached | 有风险, 已违反 |
| request (help desk) | 请求 |
| requester | 请求人 |
| copied on a request (CC), copy, stop copying | 抄送, 抄送给, 取消抄送 |
| customer group, kept from the group | 客户组, 对该组隐藏 |
| reporter | 报告人 |
| report (an issue), reported | 报告, 「{v} 于 {date} 报告」 |
| assignee | 经办人 |
| agent | 智能体 |
| assistant (its name), the assistant | 助手 |
| conversation (with the assistant) | 对话 |
| workflow | 工作流 |
| rule | 规则 |
| if (a rule's or a transition's condition) | 如果, after 「当…时」 |
| state machine | 状态机 |
| transition | 转换 |
| state | 状态 |
| knowledge base | 知识库 |
| article | 文章 |
| inbox | 收件箱 |
| notification | 通知 |
| digest | 摘要 |
| subscription, subscribe | 订阅, 订阅 |
| watch, watcher | 关注, 关注者 |
| timesheet | 工时表 |
| work logged, log time | 已记录工时, 记录工时 |
| estimate | 预估 |
| rate (per hour) | 小时费率 |
| days away, away | 休假 for both: 「添加休假」, 「下午休假」 |
| levelling | 资源平衡 |
| slack (in a plan) | 浮动时间 |
| booked (hours in a plan) | 已安排: 「已安排工时」 |
| critical path | 关键路径 |
| what-if (in a plan) | 模拟 |
| milestone | 里程碑 |
| baseline | 基线 |
| earned value, earned | 挣值 |
| cost and schedule performance (CPI, SPI) | 成本绩效指数, 进度绩效指数 |
| triage | 分诊 |
| suggestion | 建议 |
| tag | 标签 |
| token, revoke | 令牌, 撤销 |
| fingerprint (of a token) | 指纹 |
| scope (of a token) | 权限范围: 「admin 权限范围」 |
| allow (an app), apps you allowed | 授权, 「你授权的应用」 |
| not found | 找不到: 「找不到问题 {id}。」 |
| two-factor sign-in | 两步验证 |
| sign in, sign out | 登录, 退出登录 |
| login (a person's handle) | 登录名 |
| identity provider | 身份提供商 |
| single sign-on | 单点登录 |
| webhook, delivery | Webhook, 投递 |
| post (a4a or a provider sending to an address) | 发送; 发布 is for chat messages and comments |
| secret | 密钥 |
| commit, pull request, branch | 提交, 拉取请求, 分支 |
| merge, merged | 合并, 已合并 |
| build (CI) | 构建 |
| CI | CI |
| field, value | 字段, 值 |
| link (between issues), unlink | 链接, 取消链接 |
| link, unlink (a chat account) | 关联, 取消关联 |
| duplicate | 重复 |
| resolve, resolved, resolution | 解决, 已解决, 解决 (an SLA's: 解决目标) |
| dashboard, widget | 仪表板, 小部件 |
| report | 报告 |
| settings | 设置 |
| app, handler (of an app) | 应用, 处理程序 |
| key (a project's) | 项目键: 「重命名项目键」; an issue's key in another tracker is its 编号 |
| attach a file, attaching | 添加附件; a file being sent is 上传: 「正在上传 {name}」, 「{name} 上传失败」 |
| unsubscribe (from an email's link) | 退订 |
| person, people | 用户; 人 in a count |
| role, permission | 角色, 权限 |
| administrator, manager, member, viewer, guest | 管理员, 经理, 成员, 查看者, 访客 |
| whiteboard; a note, card, section, arrow, an arrow's label, the outline | 白板、便签、卡片、分区、箭头、标注、大纲 |
| connect (draw an arrow), make issues (of notes) | 连接; 转为问题 |
| a note's tones: plain, idea, agreed, question, problem, parked | 普通、想法、已商定、疑问、痛点、暂缓 |
| writing help; where an issue came from (a chat message) | 写作辅助; 来源 |
| another tracker (where an import comes from) | 其他工具 |
| provisioning (SCIM) | 预配: 「用户预配」 |

**Why 问题 for issue**: it's what Jira's Simplified Chinese says, so teams who have used a tracker read it already. 议题 (GitHub's and GitLab's) reads as a topic for discussion, 事项 and 工作项 (Feishu's, PingCode's) are less known to them, and 工单 is a help desk's ticket. 问题 also means "problem", so a4a's problems never use it for what went wrong.

**Why 经办人 for assignee**: Jira's word again, and it keeps 负责人 for a project's lead, as Jira does. Feishu and PingCode say 负责人 for both, which a4a can't, since a project's lead and an issue's assignee are often named on one page.

**Checking Simplified Chinese**: the checks above, and `e2e/chinese.spec.ts`. It signs a person of its own in, through the sign-in page of a browser that asks for Simplified Chinese, and opens the issues, an issue, the inbox and the profile. It also shows a problem on the sign-in page. It shoots each page in light, in dark and at 390px, into the HTML report and beside the test in `apps/web/test-results`.

A reader of Chinese can then:

- read those shots;
- set a profile's language to 简体中文 and walk the pages;
- read the pieces of one prefix together, since a page joins them: `activity.ledgerEntry.*`, `issues.issueHistory.*`, `server.notify.*`, `rules.words.*`.

The shots in this repository's container are drawn in WenQuanYi Zen Hei, its only CJK font. It is a Chinese font, so they look as Chinese readers expect, if plainer than Noto Sans SC or PingFang SC.

## Vietnamese

`vi.json`, as teams in Vietnam read a tracker. Intl's `vi` writes dates, numbers and lists as `vi-VN` does, so the code passes `vi` as it is.

- **"Bạn", always**, where a sentence speaks to its reader, the help desk's emails and portal included: "Bạn đã bình chọn.", "Token của bạn". Vietnamese pronouns carry age and rank (anh, chị, em, quý khách); software for teams, Google's, Microsoft's and Trello's Vietnamese among them, says "bạn", which is polite to anyone and assumes neither. "Quý khách" is a bank's or a carrier's word to its customers: on the portal it would read as a form letter beside the pages. In emails to a requester the team speaks as "chúng tôi", and the chat bot, which says "I" in English, says "tôi".
- **Sentences are plain and polite**, with no exclamation marks. A fix is a bare imperative after the sentence that says what went wrong, as Microsoft's and Google's Vietnamese give one: "Không tìm thấy nhãn “x”. Dùng một trong: …", "Thử lại sau một phút.". "Hãy" goes only after a leading clause, where a bare verb would read curt ("Nếu vẫn không được, hãy báo quản trị viên.", "Để đọc lại từ đầu, hãy nhập lại."), and "vui lòng" (please) only where English asks something of someone.
- **Buttons and labels are short verb phrases or nouns**, never sentences: "Lưu", "Lưu thay đổi", "Hủy", "Xóa trường". A button that names what it changes says it, as English's does. A label, a legend or a column names what it holds, as a Vietnamese form does, where English describes it: "Quyền" for "What it may do", "Áp dụng cho" for "Where it may", "Nguồn" for "From", "Mô tả" for "What it's for", "Kiểu dữ liệu" for "What it holds"; a table's column of several buttons is "Thao tác", and one of a single button names it ("Thu hồi"). A heading over a preview asks, as Vietnamese software does: "Quy tắc sẽ làm gì lúc này", "Trợ lý đã làm gì", not "Những gì quy tắc sẽ làm". An option or a kind stands without English's article: "lựa chọn từ danh sách", "số nguyên", "Mốc", not "một lựa chọn …".
- **Status lines** are "Đã …" for what happened and "Đang …" for what is under way: "Đã lưu.", "Đang lưu…", "Đã thêm {name}.". What someone did is said as done, by whom, not in English's passive: "Đã đổi mật khẩu và đăng xuất mọi phiên.", "Người khác đã thay đổi BACK-12 (…)", not "Mật khẩu của bạn đã được đổi", "BACK-12 đã được người khác thay đổi". A line after a toggle or a removal says what was done, then what follows from it: "Đã tắt: …", "Đã bật lại: …", "Đã thu hồi token {name}. …", "Đã gỡ token. …", not English's "{name} is revoked", "It's off"; what changes from then on is "Từ giờ, …".
- **The passive** is "được" for what is neutral or welcome and "bị" for what befalls a thing: "một vấn đề được tạo", "bình luận bị xóa", "thay đổi bị từ chối". It stays for a state ("Kênh đã bị xóa.") and in the clauses a page joins (a webhook's events, a rule's trigger). Whoever did it goes between "được" and the verb, "vấn đề được Ada báo cáo", and a byline puts them first, "Ada báo cáo ngày …"; "bởi" (by) is English's order, and a4a doesn't use it.
- **Gender**: Vietnamese nouns and verbs have none, but its pronouns do (anh ấy, chị ấy), so a4a never gives a person one: it says "người đó", "người này", "những người theo dõi", or the name again. A thing is named again rather than called "nó", which reads as spoken: "vấn đề này", "quy tắc này"; "chính nó" (itself) is the exception.
- **Roles** are words for anyone: "Quản trị viên", "Quản lý", "Thành viên", "Người xem", "Khách". In a sentence a role is bare and a page lower-cases it (`inSentence()`): "{name} giờ là thành viên của BACK".
- **Typography**:
  - Sentence case: only a sentence's first word and names take a capital ("Lưu thay đổi", "Hộp thư đến", never "Hộp Thư Đến"). "a4a" stays lower case, first in a sentence too.
  - Quotation marks are “…”, and the ellipsis is one character (…). No space before a colon or a %.
  - Letters are precomposed (NFC): ế is U+1EBF, not e with two combining marks. The catalog is NFC throughout; edit it with a Unicode keyboard (Telex or VNI typing in Unicode), never a legacy encoding.
  - Tone marks sit the traditional way in oa, oe and uy: "xóa", "hủy", "hòa", "thủy", as Microsoft's and Google's Vietnamese write them, not "xoá", "huỷ".
  - Fonts: Ocean draws Vietnamese in IBM Plex Sans's and Plex Mono's Vietnamese faces, from Ocean dd43c90 on. With an Ocean from before them, whose Plex files carry Latin-1 and no more, a page draws ă, đ, ĩ, ũ, ơ, ư and every letter with a dot below or a hook (ạ, ả, ế, ộ, ữ…) from the system's font, mid-word, while à, é, ê, ô and the plain letters stay Plex.
- **Plurals**: Vietnamese doesn't inflect for number, so each plural keeps `other` alone: `{n, plural, other {# vấn đề}}`. A noun after a number takes no marker; "các" or "những" marks a plural where no number is said ("các vấn đề đã chọn"). Where English says one differently ("this issue", "One issue matches") and Vietnamese does too, the plural keeps `=1`: `{total, plural, =1 {Một vấn đề khớp.} other {# vấn đề khớp.}}`.
- **Pieces a page joins**:
  - The activity ledger, an issue's history and notifications show who in bold, then what was done, so an action is a verb phrase with "đã" and no subject: "đã thay đổi {issue}", "đã bình luận về {issue}", "đã giao vấn đề này cho bạn". A badge is a short verb phrase in lower case, as English's is: "xóa vấn đề", "ghi thời gian". How it came is a phrase after it: "qua web", "qua MCP, thay mặt {name}". "For {name}" is "thay mặt {name}", on someone's behalf; "thay cho" would say instead of them.
  - A webhook's events are joined into "Khi {join}" by Intl's "or" list ("hoặc"), so each is a clause, in the passive where something is done to a thing: "một vấn đề được tạo", "một bình luận bị xóa", "có người bình luận". The same clauses, with a capital, label the form's checkboxes (`page.webhooks.label.*`).
  - A rule is one sentence in English's order, which is Vietnamese's: its trigger and conditions are clauses, its actions bare verbs, and the words in `<t0>` are "Khi", "nếu" and "thì": "<t0>Khi</t0> một vấn đề được tạo, <t0>nếu</t0> vấn đề khớp Type: Bug, <t0>thì</t0> áp dụng Assignee anna."
  - A loading line is a whole message, one per thing (`loadingLine.*`): "Đang tải kế hoạch…". "Của bạn" goes where it tells the reader's from someone's ("Đang tải ngày vắng mặt của bạn…", beside "… của {name}…") and is left out where it's plain ("Đang tải hộp thư đến…"); a thing's own name reads "Đang tải {name}…", and nothing, "Đang tải…". A page that loads a list says "danh sách" where the one thing would read the same ("Đang tải danh sách dự án…" beside "Đang tải dự án…"), and "các" stays out.
- **Selects and plurals the English doesn't need**: a message keeps every placeholder English has. Where Vietnamese says nothing for one, it sits in a plural or select whose only branch is an empty `other`: `{n, plural, other {}}`.
- **Selects on codes**: each case is worded in Vietnamese and every case stays: `{state, select, merged {đã hợp nhất} closed {đã đóng} other {đang mở}}`; a code no case names keeps the code in `other`.
- **Dates and numbers** come from Intl: "16 thg 11, 2026", "Thứ Hai, 16 tháng 11", "1.234,5", "3 phút trước".
- **Data stays as named**: field names, states and values ("State", "Fixed"), and examples of the query and command languages (`project: BACK #Unresolved`), as in every language.
- **Problems** say what went wrong, then the fix, each a sentence: "Không tìm thấy vấn đề BACK-12." An error is "lỗi", never "vấn đề", which is an issue. Free text from elsewhere (a parser's message, another tracker's words, a script's refusal) stays where English puts it and brings its own punctuation, so no full stop follows it: "Dịch vụ AI báo lỗi: {error}". In the query, command and rule problems, keywords and fields' names stay as typed (`for: me`, `#Unresolved`, `State`), and the parser says what Vietnamese parsers say: "Unknown X" is "Không tìm thấy X", "Expected X after Y" is "Thiếu X sau Y", "Unexpected “x”" is "“x” không hợp lệ ở đây", "Did you mean …?" is "Ý bạn là …?", and "use e.g. 2d" is "dùng định dạng như 2d".
- **You and your**: "của bạn" after the noun where a label must tell the reader's from someone else's ("Token của bạn", "Yêu cầu của bạn"), and nothing where the owner is plain ("Hồ sơ", "Hộp thư đến", "Cài đặt email", "Đồng hồ bấm giờ"), in sentences too: "Đã gửi, thông báo sẽ hiện ngay trên thiết bị.", not "… thiết bị của bạn". The sign-in card says it as Google's does: "Dùng tài khoản a4a của bạn.". What the reader says on a button is "tôi": "Giao cho tôi".
- **The help desk** is "bộ phận hỗ trợ", a request "yêu cầu" and its requester "người yêu cầu". Its emails and portal say "bạn" to the requester, and the team writes as "chúng tôi": "Chào {name}, chúng tôi đã nhận được yêu cầu của bạn."

| English | Vietnamese |
|---|---|
| issue | vấn đề |
| summary (an issue's title) | tiêu đề |
| description | mô tả |
| project | dự án |
| key (a project's), id (an issue's) | mã dự án, mã vấn đề; "khóa" is a cryptographic or a stored key |
| open (a project, to everyone signed in), open to guests | mở cho mọi người; công khai |
| lead (of a project) | trưởng dự án |
| board, card | bảng, thẻ |
| column, swimlane | cột, làn |
| sprint | sprint |
| committed (a sprint's commitment) | cam kết |
| blocker | trở ngại |
| backlog | backlog |
| help desk, its portal | bộ phận hỗ trợ, cổng hỗ trợ |
| SLA at risk, breached | sắp vi phạm, đã vi phạm |
| request (help desk) | yêu cầu |
| requester | người yêu cầu |
| copied on a request (CC), copy, stop copying | được CC, CC, bỏ CC |
| customer group, kept from the group | nhóm khách hàng, ẩn với nhóm |
| reporter | người báo cáo |
| report (an issue), reported | báo cáo, đã báo cáo |
| assignee | người được giao |
| assign | giao |
| agent | tác nhân |
| assistant (its name), the assistant | assistant, trợ lý |
| conversation (with the assistant) | cuộc trò chuyện |
| workflow, script | workflow, script |
| rule, guard (a rule that refuses) | quy tắc, quy tắc chặn |
| if (a rule's or a transition's condition) | nếu, after the trigger's "Khi" |
| state machine | máy trạng thái |
| transition | bước chuyển |
| state | trạng thái |
| knowledge base | cơ sở kiến thức |
| article | bài viết |
| inbox | hộp thư đến |
| notification | thông báo |
| digest | bản tổng hợp |
| subscription, subscribe | đăng ký, đăng ký nhận |
| watch, watcher | theo dõi, người theo dõi |
| comment | bình luận |
| mention | nhắc đến |
| tag | nhãn |
| vote | bình chọn |
| timesheet | bảng chấm công |
| work logged, log time | thời gian đã ghi, ghi thời gian |
| a time entry, a worklog, a work item (another tracker's) | bản ghi thời gian, bản ghi công việc, mục công việc |
| estimate | ước tính |
| rate (per hour) | đơn giá theo giờ |
| days away, away | ngày vắng mặt, vắng mặt |
| levelling | cân bằng nguồn lực |
| slack (in a plan) | thời gian dự trữ |
| booked (in a plan) | đã phân bổ |
| critical path | đường găng |
| milestone | mốc |
| baseline | đường cơ sở |
| what-if | mô phỏng |
| earned value, earned | giá trị thu được (EV), thu được |
| cost and schedule performance (CPI, SPI) | hiệu suất chi phí, hiệu suất tiến độ |
| triage | phân loại |
| suggestion | gợi ý |
| token, revoke | token, thu hồi |
| fingerprint (of a token) | dấu vân tay |
| scope (of a token) | phạm vi; on the page, where English says "What it may do" and "Where it may": "Quyền", "Áp dụng cho" |
| two-factor sign-in | xác thực hai yếu tố |
| sign in, sign out | đăng nhập, đăng xuất |
| login (a person's handle) | tên đăng nhập |
| identity provider | nhà cung cấp danh tính |
| single sign-on | đăng nhập một lần (SSO) |
| webhook, delivery | webhook, lượt gửi |
| post (a4a or a provider sending to an address) | gửi; "đăng" is for chat messages and comments |
| secret | khóa bí mật |
| commit, pull request, branch | commit, pull request, nhánh |
| merge, merged | hợp nhất, đã hợp nhất |
| build (CI) | bản build |
| CI | CI |
| repository | kho mã |
| field, value | trường, giá trị |
| link (between issues), unlink | liên kết, bỏ liên kết |
| link, unlink (a chat account) | liên kết, hủy liên kết |
| duplicate | trùng lặp |
| resolve, resolved, resolution | giải quyết, đã giải quyết; an SLA's resolution: giải quyết |
| not found | không tìm thấy |
| dashboard, widget | bảng điều khiển, tiện ích |
| report | báo cáo |
| query, command, saved search | truy vấn, lệnh, tìm kiếm đã lưu |
| attachment, file | tệp đính kèm, tệp |
| settings | cài đặt |
| app, handler (of an app) | ứng dụng, trình xử lý |
| allow (an app) | cho phép |
| person, people | người, mọi người; "người dùng" in administration |
| for {name} (acting on their behalf), as {name} | thay mặt {name}, với tư cách {name}; an integration reads "với tư cách GitHub App" |
| table (a screen reader's name for one) | danh sách; "bảng" is a board |
| role, permission | vai trò, quyền |
| take out (of a project, a group) | gỡ … khỏi; the ledger says "đã xóa … khỏi" |
| administrator, manager, member, viewer, guest | quản trị viên, quản lý, thành viên, người xem, khách |
| problem (what went wrong) | lỗi |
| whiteboard; a note, card, section, arrow, an arrow's label, the outline | bảng trắng, ghi chú, thẻ, khu vực, mũi tên, chú thích, dàn ý |
| connect (draw an arrow), make issues (of notes) | nối; tạo vấn đề |
| a note's tones: plain, idea, agreed, question, problem, parked | Thường, Ý tưởng, Đã thống nhất, Câu hỏi, Khó khăn, Tạm gác |
| writing help; where an issue came from (a chat message) | hỗ trợ viết; nguồn gốc |

**Why vấn đề for issue**: it's Redmine's Vietnamese, and the word Vietnamese-speaking teams use when they don't say "issue". "Phiếu" (ticket) reads as a form or a support desk's, "sự cố" as an incident, and "công việc" (task) leaves out bugs and requests. As far as this catalog's writer knows, neither Jira nor YouTrack has a Vietnamese interface, so the catalog leans on Redmine's and Trello's Vietnamese (bảng, thẻ and nhãn are Trello's), on Vietnamese project management's own terms (đường găng, đường cơ sở, giá trị thu được, thời gian dự trữ), and, where Vietnamese teams say the English word, on that: sprint, backlog, commit, pull request, webhook, token, workflow.

**Checking Vietnamese**: the checks above, and `e2e/vietnamese.spec.ts`. It signs a person of its own in, through the sign-in page of a Vietnamese browser, opens the issues, an issue, the inbox and the profile, and shows a problem on the sign-in page; each is shot in light, in dark and at 390px, into the HTML report and beside the test in `apps/web/test-results`. A reader of Vietnamese then reads those shots, sets a profile's language to Tiếng Việt and walks the pages, and reads the pieces of one prefix together, as a page joins them: `activity.ledgerEntry.*`, `issues.issueHistory.*`, `server.notify.*`, `rules.words.*`.

## Indonesian

`id.json`, in the Indonesian of Indonesia's offices and software teams: standard spelling (KBBI and EYD), plain, and polite without ceremony.

- **Anda**, with its capital, where the reader must be named, as Indonesian software addresses its reader; never "kamu", "kau" or "-mu". English says "you" and "your" on nearly every line, and Indonesian doesn't: what the page plainly is about needs no owner ("Profil", "Memuat kotak masuk…", "Ponsel hilang? Masukkan salah satu kode pemulihan."), and a sentence about what can be done takes the di- passive or the passive with "Anda" before the verb rather than "Anda dapat …" ("Pengguna lain dapat diundang setelahnya.", "isu yang Anda pantau"). A sentence says "Anda" once, not two or three times, and "memiliki", never "Anda punya". "Silakan" and "mohon" are for where English says "please", where something is asked of someone; a line doesn't open with them.
- **Buttons and labels are short verb phrases or nouns**, never sentences: "Simpan", "Simpan perubahan", "Hapus bidang", "Batal". An instruction is the plain imperative, without "-lah" or "mohon": "Pilih proyek", "Ketik namanya". A label is a noun, not "-nya" pointing back as English's "its" does: "Nama", "Nilai (3)", "Posisi sekarang", "Kegunaan". An optional field says "(opsional)" after its name ("Komentar (opsional)", "Catatan (opsional)") where English says "if you want one", and a form's labels are those of Indonesian forms: "Nama lengkap", "Konfirmasi kata sandi baru", "Perihal". A field's help says what to type, "Kosongkan untuk branch apa pun", not English's "Empty: any". A choice of all of something is "Semua proyek", not "Setiap proyek"; a table's columns are what Indonesian tables head them with ("Waktu", "Hasil", "Sumber", "Keterangan", "Status"), and a report's rows go "per hari", "per minggu", never "hari demi hari", which reads as "little by little".
- **Someone acting for someone** is "atas nama": an agent or a script "atas nama Ada", an agent with its own token "atas nama sendiri", in the history's and the ledger's lines, the notifications and the profile. A rule or an app acting by itself is "otomatis" ("· otomatis ·"); `ui.who.onItsOwn` keeps "dengan sendirinya", since the name before it may be "otomatisasi".
- **Plain words for the assistant** are "kalimat biasa": "Tanya dengan kalimat biasa", "Tulis perintah dengan kalimat biasa", and its button "Ubah jadi perintah".
- **Status lines are passive**: "Tersimpan.", "{name} ditambahkan.", "Dihapus."; what is under way is the active form, with the ellipsis: "Menyimpan…", "Mengirim…". The copy button's line, which a screen reader hears while the button itself says "Disalin", puts the word first, "Disalin: token." (`common.copyButton.copied`), since a copied thing's name begins in lower case.
- **Verbs carry no tense.** A line whose place says it happened (the history, a notification) needs no "telah" or "sudah": "mengubah status". "Sudah" is English's "already", "masih" its "still", "belum" its "not yet", and "akan" its "will".
- **Pronouns have no gender**: "dia", "ia" and "-nya" are anyone's, so a4a never guesses a person's. "-nya" also stands for a thing ("mengubahnya"); where it could be read as either, the sentence names the thing.
- **Typography**: sentence case, as English's; quotation marks “…”, ‘…’ inside them, in problems too, where English writes straight ones; JSON a script sends keeps its straight quotes (`"all": true`). The one-character ellipsis (…); no space before ":", "?" or "!". A time in prose is written with a point, as Indonesia writes it ("Senin 09.00–17.00"); what a parser reads keeps its colon ("tomorrow 09:30"). An Indonesian prefix on an English word takes a hyphen, as EYD writes it ("di-merge"), and an Indonesian verb is taken where there is one ("diunggah", not "di-upload"). A noun needs no "sebuah" or "seorang" where English's "a" stood before it ("Uji pada isu", "Gambar").
- **Plurals**: Indonesian doesn't inflect for number, and doesn't double a noun after a number or a word of quantity ("3 isu", "semua isu", "beberapa komentar"; never "3 isu-isu"), so each plural keeps `other` alone: `{n, plural, other {# isu}}`. Where English words none or exactly one apart and Indonesian does too, `=0` or `=1` stays beside it: `{n, plural, =0 {Tidak ada isu} other {# isu}}`. A noun without a number is the same for one or many: "Isu" heads the page of them.
- **Pieces a page joins**:
  - The activity ledger, an issue's history and notifications show who, in bold, then what was done. So an action is an active verb phrase, with its meN- prefix and no subject: "membuat {issue}", "mengomentari", "melaporkan", "menugaskannya kepada Anda". A ledger's badge says what its kind of event does, the same way and as English's do: "berkomentar", "menghapus isu".
  - A webhook's events are joined into "Ketika {join}" by Intl's "or" list, "A atau B", "A, B, atau C", so each is a clause, passive where something is done to a thing: "Ketika isu dibuat atau seseorang berkomentar". The same clauses, with a capital, label the form's checkboxes (`page.webhooks.label.*`).
  - A rule is one sentence, in English's order, which Indonesian shares: its trigger and conditions are clauses, its actions are imperatives, and the words in `<t0>` are "Saat", "jika" and "maka": "<t0>Saat</t0> isu dibuat, <t0>jika</t0> cocok dengan Type: Bug, <t0>maka</t0> terapkan Assignee anna". An action that does nothing says so without an order: "tidak ada tindakan", "beri tahu “…” (tanpa penerima)".
  - A board's drop announcements join a lane's piece after "untuk" or "dan", so each piece is a meN- verb: "Lepaskan untuk memindahkan BACK-1 ke Done dan menugaskannya kepada Ada".
  - A loading line is a whole message, one per thing (`loadingLine.*`): "Memuat" and the thing, "Memuat rencana…", "Memuat permintaan Anda…", "Memuat {name}…", and "Memuat…" where nothing is named.
- **Selects and plurals the Indonesian doesn't need**: a message keeps every placeholder English has. Where Indonesian says nothing for one, it sits in a plural or select whose only branch is an empty `other`: `{n, plural, other {}}`. Where English selects on a code (a pull request's `merged`, a unit's `points`, a role's `admin`, a report's `week`), each case is whole Indonesian, and `other` keeps the code where English's does.
- **Problems** say what went wrong, then the fix, each a plain sentence: "Nama pengguna atau kata sandi salah.", "Nama itu sudah dipakai. Pilih nama lain." Something a4a can't find is "tidak ditemukan", an unknown project too; what failed is "gagal …" ("{name} gagal dilampirkan."); asking an administrator is "Hubungi administrator". A value to type is asked for with "Masukkan" or "Isi", not English's "Give" ("Masukkan alamat https-nya", "Isi “issue”, misalnya BACK-12"), and a missing one is "wajib diisi" ("Nama wajib diisi."). Someone's change in between is "baru saja diubah orang lain. Muat ulang, lalu ulangi perubahan Anda." Free text from elsewhere (another tracker's words, a script's refusal, a parser's message) stays where English puts it and brings its own full stop. In the query, command and rule problems, the languages' keywords and the fields' names stay as typed (`for: me`, `#Unresolved`, `sort by`, `State`).
- **You and your**: "Anda" after what it owns, where the owner must be told ("Token Anda", "Permintaan Anda"), and nothing where it's plain: a page's heading is "Profil", not "Profil Anda".
- **The help desk** is for people outside the team: they send a "permintaan", and are its "pemohon". Its emails and its portal are a company's words to its customers: "Anda", courteous and plain, with no "Yth." or "Bapak/Ibu", since a4a doesn't know who reads them. The first email greets as a service desk does, "Halo {name}, permintaan Anda sudah kami terima.", and the portal asks "Ada yang bisa kami bantu?" over a request's summary.
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
| due, due date | tenggat ("tenggat 2 jam lagi", "Tanpa tenggat"), not "jatuh tempo", a bill's |
| request (help desk) | permintaan |
| requester | pemohon |
| copied on a request (CC), copy, stop copying | penerima tembusan, tambahkan ke tembusan, hapus dari tembusan |
| customer group, kept from the group | grup pelanggan, dirahasiakan dari grup |
| reporter | pelapor |
| report (an issue), reported | melaporkan, dilaporkan |
| assignee, assign | penerima tugas, tugaskan |
| agent | agen |
| assistant (its name), the assistant | assistant, asisten |
| for (acting for someone), as itself, on its own | atas nama {name}, atas nama sendiri, otomatis |
| in words (plain language for the assistant) | dengan kalimat biasa |
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
| who subscribed a chat channel | pembuat langganan, its column "Penanggung jawab"; not "pelanggan", a customer |
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
| restore (an earlier version) | pulihkan |
| make it yours (the starting dashboard) | sesuaikan; "Dasbor saya", "Milik saya", as Google Drive's "Drive Saya" |
| earned value | nilai hasil (EV) |
| cost and schedule performance (CPI, SPI) | kinerja biaya, kinerja jadwal |
| what-if | simulasi |
| triage | triase |
| suggestion | saran |
| tag | tag |
| token, revoke | token, cabut |
| read-only (a token, an app's access) | hanya-baca |
| forget (an app's key, a login) | lupakan, as Android's "Lupakan"; in a sentence "menghapus kunci" |
| kept sealed (a secret a4a holds) | disimpan terenkripsi |
| fingerprint (of a token) | sidik jari |
| scope (of a token) | cakupan |
| not found | tidak ditemukan, after the thing: "Isu {id} tidak ditemukan." |
| two-factor sign-in | autentikasi dua faktor |
| sign in, sign out | masuk, keluar |
| login (a person's handle) | nama pengguna |
| identity provider | penyedia identitas |
| single sign-on | single sign-on (SSO) |
| webhook, delivery | webhook, pengiriman ("Pengiriman terbaru", "pengiriman terakhir"); never "kiriman", a social post |
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
| whiteboard; a note, card, section, arrow, an arrow's label, the outline | papan tulis, catatan, kartu, bagian, panah, label, kerangka |
| connect (draw an arrow), make issues (of notes) | hubungkan; jadikan isu |
| a note's tones: plain, idea, agreed, question, problem, parked | Biasa, Ide, Disepakati, Pertanyaan, Masalah, Ditunda |
| writing help; where an issue came from (a chat message) | bantuan menulis; asal isu |

**Why isu for issue**: it is the word Indonesian developers already say, in KBBI's spelling, and it covers a bug, a task and a request alike. "Masalah" is a problem, which a feature request isn't; "tiket" reads as a help desk's or a train's; "tugas" is a task, one kind of issue among others.

**Checking Indonesian**: the checks above, then `e2e/indonesian.spec.ts`: a person of its own signs in through an Indonesian browser, and the issues, an issue, the inbox, the profile and a problem on the sign-in page are shot in light, in dark and at 390px. A reviewer who reads Indonesian walks the same pages and the emails (`server.*` keys), and reads each prefix's pieces together, as they join: the ledger (`activity.ledgerEntry.*`), an issue's history (`issues.issueHistory.*`), a rule's sentence (`rules.words.*`) and the notification titles (`server.notify.*`).

## Thai

`th.json`, as Thai teams read a tracker, for Thailand: Thai script, Gregorian years, Arabic digits.

- **Polite and plain, with no speaker in it.** Sentences are whole and polite, as Thai software for teams writes them, and carry no particle: never ครับ or ค่ะ, which say the speaker's gender, nor นะ, which is talk. คุณ is the reader, where a sentence must address them: “คุณเข้าสู่ระบบด้วย {login}”. Thai leaves out whom it has already named, so a sentence never says เขา or เธอ (either can read as one gender): it leaves the person out, or names them again.
- **Buttons and labels are short verb phrases or nouns**, never sentences: “บันทึก”, “บันทึกการเปลี่ยนแปลง”, “ลบฟิลด์”. A status line says what's done with แล้ว and what's going on with กำลัง: “บันทึกแล้ว”, “กำลังบันทึก…”, “เพิ่ม {name} แล้ว”.
  - A label or a column's head is the noun a Thai form uses, never English's question or bare word: “ใช้สำหรับ” for "What it's for", “ผู้ใช้” for "Whose" and "Person", “ขอบเขต” over a token's scopes, “เวลา” or “ช่วงเวลา” for "When", and a "From" says what it chooses (“นำเข้าจาก”, “ผู้ให้บริการ”). "{v} only" is “เฉพาะ {v}”.
  - A confirm button names what it removes: “ลบไวต์บอร์ด”, a field's “ลบฟิลด์” and a value's “ลบค่า” (`page.fields.deleteIt`, `page.fields.deleteTheValue`), an integration's “นำการเชื่อมต่อออก” and its token's “นำโทเค็นออก” (`page.integrations.removeIt`, `page.integrations.removeTheToken`). "Nobody can bring it back" is “กู้คืนไม่ได้”.
- **The chat bot names itself a4a**, as its handle reads in Slack and Teams (“a4a ไม่ได้อยู่ใน {channel} เชิญด้วย /invite @a4a”), or leaves itself out (“ยังไม่รู้ว่าคุณเป็นใครใน a4a”); never บอต for itself, nor ผม or ฉัน. Its help lists “คำสั่งที่ใช้ได้”.
- **Instructions are bare verbs**, as Thai apps give them: “เลือกโปรเจกต์”, “ลองอีกครั้ง”. โปรด only where English says please, where something is asked of someone; never กรุณา, which reads as a notice.
- **Typography:**
  - No space between words. A space between phrases, clauses and sentences, where Thai pauses, and on each side of a value, a number, an id or a Latin word: “เปิด {issue}”, “อิชชู {n} รายการ”, “ตาม Type: Bug”. None before `:` or `)`, or inside “”. A value that is itself Thai, a piece the page translates, joins as a word does: “ใช้{formName} ของคุณ” reads “ใช้ชื่อผู้ใช้ a4a ของคุณ”.
  - **No full stop.** Thai ends a sentence with a space, and its last with nothing. A message of two sentences has a space between them; sentences a page joins (`sentences()`, a problem's list of problems) are joined by a space (`SENTENCE_GAP`), so no Thai message ends in a full stop and none needs one. A question ends in `?` after its question word (“ลบ {name} ไหม?”), as Thai's ปรัศนี does. `.` stays only inside abbreviations (พ.ย.) and code.
  - Quotation marks are “…”, the ellipsis is one character (…), and digits are Arabic, never Thai ones (๑๒๓).
  - **A colon introduces** a list, a value, code, or a help text's “ว่างไว้: …”; it never joins a statement to its reason or its consequence, as English's does. Thai says the link, or pauses: “ปิดอยู่ จึงไม่มีใครเห็นปุ่มนี้”, “{name} เป็นฟิลด์ส่วนตัวไม่ได้ เพราะ…”, not “ปิดอยู่: ไม่มีใครเห็นปุ่มนี้”.
- **Line breaks and badges.** A Thai line breaks only at a space or where the browser's dictionary finds a word's end, and a transliterated word it doesn't know can't break at all. So badges and buttons are a word or two (“ปิดแล้ว”, “เกินกำหนด”), and the pages the browser spec shoots were looked at at 390px, where none spills.
- **Font.** Ocean sets Thai in IBM Plex Sans Thai, which it bundles for Thai's letters alone (`unicode-range`), after IBM Plex Sans for Latin (`--font-sans`): the two share their weights and x-height, so a Latin id inside a Thai sentence sits level with it. Plex Sans Thai is loopless, the modern style of Thai screens. `e2e/thai.spec.ts` asks the browser which font drew the Thai on each page (Chromium's `CSS.getPlatformFontsForNode`), and fails unless it's Plex Sans Thai; the container's shots show Plex Sans Thai, served from Ocean's own files, not a system font.
- **Plurals**: Thai has none, so each plural keeps `other` alone and counts as Thai counts: the noun, the number, then its classifier: `{n, plural, other {อิชชู # รายการ}}`. รายการ counts issues, requests, comments, changes and things; คน people; ครั้ง times; ข้อ rules and points; ตัว agents and bots; ไฟล์, วัน, ชั่วโมง, โปรเจกต์, บอร์ด, กลุ่ม, แอป count themselves (“3 ไฟล์”). A plural English words otherwise for none or one keeps `=0` or `=1` where Thai does too: `{n, plural, =0 {ไม่มีเวลาเหลือ} other {มีเวลาเหลือ # วัน}}`. A plain count of none stays a count: “อิชชู 0 รายการ”.
- **Selects and plurals the English doesn't need**: a message keeps every placeholder English has. Where Thai says nothing for one, it sits in a plural or select whose only branch is an empty `other`: `{n, plural, other {}}`.
- **Pieces a page joins.** Thai's order is English's, subject, verb, object, so the pieces join as English's do:
  - The activity ledger, an issue's history and notifications show who in bold, then what they did: a verb phrase with no subject, and no tense, since its time is shown beside it: “สร้าง {issue}”, “แสดงความคิดเห็นใน {issue}”, “มอบหมายอิชชูนี้ให้คุณ”. A badge is a short verb phrase, as a Thai label is: “ลบอิชชู”. Who acted for someone is “ในนาม {name}”, never สำหรับ.
  - A webhook's events are joined by Intl's “หรือ” after “เมื่อ”, each an event as Thai says one happens, with มีการ: “มีการสร้างอิชชู”, not the passive ถูก, which says something bad befell it. The same clauses label the form's checkboxes (`page.webhooks.label.*`).
  - A rule is one sentence: “เมื่อ” before its trigger, “ถ้า” before its conditions and “ให้” before its actions, the words in `<t0>`: “<t0>เมื่อ</t0>มีการสร้างอิชชู <t0>ถ้า</t0>ตรงกับ Type: Bug <t0>ให้</t0>ใช้ Assignee anna”.
- **A loading line is a whole message**, one per thing (`loadingLine.*`): “กำลังโหลด” and the thing, with no owner: “กำลังโหลดแผน…”, “กำลังโหลดกล่องจดหมาย…” for “Loading your inbox…”. A thing's own name or id reads “กำลังโหลด {name}…”, and nothing, “กำลังโหลด…”.
- **Lists and units** are Intl's, spaced as Thai sets Latin off. Intl's Thai list is made for Thai words: a bare space between items, และ glued to the next (“แอปเปิล ส้ม และกล้วย”, “SPRและที่ยังไม่ปิด”). Most of a4a's lists are names and ids, so `listParts` (in `packages/shared/src/i18n.ts`, under every list the server and the web make) spaces และ and หรือ off from an item that isn't Thai, and turns a bare space beside one into a comma, as Intl's Thai "or" list has it: “Anna Schmidt, Ben Okafor และอีก 3 คน”, “ในโปรเจกต์ SPR และที่ยังไม่ปิด”. A list of Thai words stays as Intl writes it. Units take Intl's short width, which keeps the space Thai puts before a unit (“1.5 ชม.”), where the narrow one other languages use glues it on (“1.5ชม.”).
- **Dates and numbers** come from Intl, in `th-TH-u-ca-gregory-nu-latn`: “17 พ.ย. 2026”, “1,234.5”, “3 นาทีที่ผ่านมา”. Intl's `th` counts years in the Buddhist era (2569 for 2026), as Thai forms and banks do. a4a's pages, emails, push and chat write Gregorian years instead, unmarked, because every date a4a takes from people is Gregorian: a query's `updated: 2026-11-01`, a command's `Due 2026-12-01`, a date field's ISO value, an import's and a commit's times. A Buddhist year beside them would be a sum to do in one's head, and a due date 543 years out is still a valid date, so a slip wouldn't show. Thai software teams read Gregorian years in the tools they work in, which are mostly in English; a Buddhist-era year is 25xx, so neither reads as the other. Digits are Arabic, Thai's own default in Intl, made explicit with `nu-latn`.
- **Field names, states and values** are data, as in every language: the field panel says STATE and PRIORITY as they were named.
- **Selects on codes**: where English selects on a stable code (a pull request's `merged`, a unit's `points`, a role's `admin`, a report's `week`, a rule part's `trigger`), each case is whole Thai, and every case stays: `{state, select, merged {เมิร์จแล้ว} closed {ปิดแล้ว} other {เปิดอีกครั้ง}}`. A field's `{type}` in a problem is such a code too, with `other` keeping the code.
- **Problems** say what went wrong, then the fix, a space between and no full stop: “ไม่พบอิชชู {id} ใช้รหัสที่อ่านได้ เช่น BACK-12”. Free text from elsewhere (a parser's message, another tracker's own words, a script's refusal) ends the Thai message, after “ข้อผิดพลาด: ”, “เหตุผล: ” or “คำตอบ: ”, and brings its own punctuation. A problem held in another's values (`{problems}`, `{reasons}`, a parser's `{problem}`) is said whole in Thai, and Thai joins sentences with a space, so it stays where English puts it. In the query, command and rule problems, the languages' keywords and fields' names stay as typed (`for: me`, `#Unresolved`, `sort by`, `State`), and a rule's choices are said as the rule form names them.
- **You and your**: ของคุณ where English's "your" tells the reader's things from others' (“คำขอของคุณ” on the portal, “โทเค็นของคุณ”), and nothing where the owner is plain: “โปรไฟล์”, “ตัวจับเวลา”, “กำลังโหลดกล่องจดหมาย…”. A button the reader presses for themself, which English words with "my" (“Save my week”), says ของฉัน, as Thai apps name the reader's own (“บันทึกสัปดาห์ของฉัน”). คุณ stays where the reader must be told from someone else: “ทำงานในนามของคุณ”, “ในนาม {login} ไม่ใช่ในนามของคุณ”.
- **The help desk** is a company's to its customers. A request is คำขอ: “ส่งคำขอ” in an issue's history and notifications, “ขอความช่วยเหลือ” on the form and the portal. Its emails to requesters are polite as Thai customer mail is, and name the requester with คุณ before the name, a space between, since a name may be Thai or Latin: “คุณ {name}”. They say why they came: “คุณได้รับอีเมลนี้เนื่องจากคุณส่งคำขอถึง {desk}”, and tell rather than email: “จะแจ้งให้คุณทราบทางอีเมล”. Wherever a customer reads it (the portal, the public form, the tracking page, the emails), the team is ทีมงาน, as Thai support writes it; the team's own pages say ทีม.

| English | Thai |
|---|---|
| issue | อิชชู |
| summary (an issue's title) | หัวเรื่อง |
| description | คำอธิบาย |
| subtask, parent | งานย่อย, อิชชูหลัก |
| project | โปรเจกต์ |
| lead (of a project) | หัวหน้าโปรเจกต์ |
| board | บอร์ด |
| sprint | สปรินต์ |
| committed (a sprint's commitment) | ที่ตกลงไว้ |
| blocker | อุปสรรค |
| backlog | แบ็กล็อก |
| help desk | เฮลป์เดสก์ |
| SLA at risk, breached | เสี่ยง, เกินกำหนด |
| request (help desk) | คำขอ |
| requester | ผู้ร้องขอ |
| copied on a request (CC), copy, stop copying | สำเนา, ส่งสำเนาถึง, เลิกส่งสำเนา |
| customer group, kept from the group | กลุ่มลูกค้า, ซ่อนจากกลุ่ม |
| reporter; report (an issue), reported | ผู้รายงาน; รายงาน, รายงานโดย |
| assignee; assign | ผู้รับผิดชอบ; มอบหมาย |
| agent | เอเจนต์ |
| assistant (its name), the assistant | assistant, ผู้ช่วย |
| conversation (with the assistant) | บทสนทนา |
| comment, mention | ความคิดเห็น, กล่าวถึง |
| attachment | ไฟล์แนบ |
| workflow | เวิร์กโฟลว์ |
| rule | กฎ |
| if (a rule's or a transition's condition) | ถ้า, after a trigger's “เมื่อ” |
| state machine | เครื่องสถานะ |
| transition, a machine's moves | การเปลี่ยนสถานะ; “เปลี่ยนสถานะ” on the issue's bar |
| state | สถานะ |
| knowledge base | ฐานความรู้ |
| article | บทความ |
| inbox | กล่องจดหมาย |
| notification | การแจ้งเตือน |
| digest | สรุป |
| subscription, subscribe | การสมัครรับ, สมัครรับ |
| watch, watcher | ติดตาม, ผู้ติดตาม |
| timesheet | ใบลงเวลา |
| work logged, log time | เวลาที่บันทึก, บันทึกเวลา |
| estimate | ประมาณการ |
| rate (per hour) | อัตราต่อชั่วโมง |
| days away, away | วันที่ไม่อยู่, ไม่อยู่ |
| levelling | การปรับระดับทรัพยากร |
| slack (in a plan) | เวลาลอยตัว |
| booked (hours in a plan) | ที่ลงแผนไว้: “ชั่วโมงที่ลงแผนไว้”, never จอง |
| critical path | เส้นทางวิกฤต |
| milestone | ไมล์สโตน |
| what-if | จำลองสถานการณ์ |
| baseline | แผนฐาน |
| earned value, earned | มูลค่าที่ได้รับ (EV), ได้รับ |
| cost and schedule performance (CPI, SPI) | ดัชนีต้นทุน (CPI), ดัชนีกำหนดการ (SPI) |
| triage | คัดกรอง |
| suggestion | คำแนะนำ |
| tag | แท็ก |
| token, revoke | โทเค็น, เพิกถอน |
| scope (of a token) | ขอบเขต |
| fingerprint (of a token) | ลายนิ้วมือ |
| allow (an app) | อนุญาต: “แอปที่คุณอนุญาต” |
| not found | ไม่พบ, before the thing: “ไม่พบอิชชู {id}” |
| two-factor sign-in | การยืนยันแบบ 2 ขั้นตอน |
| sign in, sign out | เข้าสู่ระบบ, ออกจากระบบ |
| login (a person's handle) | ชื่อผู้ใช้ |
| identity provider | ผู้ให้บริการข้อมูลประจำตัว |
| single sign-on | การเข้าสู่ระบบครั้งเดียว (SSO) |
| webhook, delivery | เว็บฮุก, การส่ง |
| post (a4a or a provider sending to an address) | ส่ง; โพสต์ is for chat messages |
| secret | รหัสลับ |
| commit, pull request, branch | คอมมิต, พูลรีเควสต์, แบรนช์ |
| merge, merged | เมิร์จ, เมิร์จแล้ว |
| build (CI), CI | บิลด์, CI |
| field, value | ฟิลด์, ค่า |
| link (between issues), unlink | ลิงก์, ยกเลิกลิงก์ |
| link, unlink (a chat account) | เชื่อมบัญชี, ยกเลิกการเชื่อมบัญชี |
| duplicate | ซ้ำ |
| resolve, resolved, resolution | ปิด, ปิดแล้ว, การปิด (an SLA's: เป้าหมายการปิด) |
| dashboard, widget | แดชบอร์ด, วิดเจ็ต |
| report | รายงาน |
| settings | การตั้งค่า |
| app, handler (of an app) | แอป, ตัวจัดการ |
| person, people | ผู้ใช้; คน counts them |
| role, permission | บทบาท, สิทธิ์ |
| member, viewer, manager, administrator, guest | สมาชิก, ผู้ดู, ผู้จัดการ, ผู้ดูแลระบบ, ผู้เยี่ยมชม |
| whiteboard; a note, card, section, arrow, an arrow's label, the outline | ไวต์บอร์ด, โน้ต, การ์ด, ส่วน, ลูกศร, ป้ายกำกับ, เค้าร่าง |
| connect (draw an arrow), make issues (of notes) | เชื่อม; สร้างอิชชู |
| a note's tones: plain, idea, agreed, question, problem, parked | ธรรมดา, ไอเดีย, ตกลงแล้ว, คำถาม, ปัญหา, พักไว้ |
| writing help; where an issue came from (a chat message) | ช่วยเขียน; ที่มา |

**Where the words come from.** Jira and YouTrack have no Thai interface, so Thai teams read both in English and say their words as Thai loanwords: อิชชู, สปรินต์, แบ็กล็อก, บอร์ด, คอมมิต, เมิร์จ. The catalog writes those in Thai script, spelled by the Royal Institute's rules for loanwords, and takes Thai's own word where teams use one: ผู้รับผิดชอบ for the assignee, คำขอ for a request, ความคิดเห็น and กล่าวถึง as Facebook's and YouTube's Thai say them, เข้าสู่ระบบ as every Thai sign-in page does.

**Why อิชชู for issue.** It's what Thai teams say for what Jira and YouTrack call an issue. ปัญหา, Redmine's and Mantis's Thai, makes "create issue" สร้างปัญหา, Thai for making trouble, and "this issue has a problem" ปัญหานี้มีปัญหา, while a4a's problems are its own word; and a feature isn't one. ทิกเก็ต reads as a support ticket, the help desk's, and งาน is taken by work: work logged, working hours, a plan's booked work.

**Checking Thai**: the checks above, and `e2e/thai.spec.ts`. It signs a person of its own in, through the sign-in page of a Thai browser, and opens the issues, an issue, the inbox and the profile, with a date in Gregorian years; and it shows a problem on the sign-in page. It shoots each page in light, in dark and at 390px, where nothing may spill sideways, and asks the browser which font drew the Thai. A reader of Thai can read those shots, set a profile's language to ไทย and walk the pages, and read the pieces of one prefix together, since a page joins them: `activity.ledgerEntry.*`, `issues.issueHistory.*`, `server.notify.*`, `rules.words.*`.
