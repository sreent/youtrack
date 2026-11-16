# Translating a4a

a4a speaks to each person in their own language (D49 in [architecture.md](architecture.md)). English is the source; German is complete. This page says how a4a sounds in a language, the words German chose for a4a's terms, how to check a language, and how to add one.

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

## French

French (`fr.json`) is complete, written for France and Canada alike: no word only one of them uses ("e-mail", read in both, rather than "courriel" or "mail").

- **Vous**, always: "Enregistrez d'abord", "Votre profil". Never "tu".
- **Buttons are infinitives**: "Enregistrer", "Annuler", "Supprimer le champ". A status line is a past participle or a short sentence: "Enregistré.", "Enregistrement…".
- **Gender**: a4a never guesses a person's, and nothing agrees with the reader or the actor: "{who} vous mentionne" (not "vous a mentionné·e"), "Commenté par {them}", "vos abonnements" (not "vous êtes abonné"), "en accès invité" (not "en tant qu'invité"). A person is "la personne", "qui…", "toute personne qui…"; no "·e" endings, which screen readers read badly. The built-in roles are words for anyone: **Admin**, **Gestionnaire**, **Membre**, **Lecture seule**.
- **Typography, as France sets it**: a no-break space (U+00A0) before ":", a narrow one (U+202F) before ";", "?" and "!" and inside « », and ’ for the apostrophe. The catalog holds those characters, so edit it with them. A plain ' before "{" would quote the brace in ICU; ’ never does.
- **Accents on capitals**: État, À, Échec.
- **What a page loads**: the words after "Chargement" carry their "de" ("des agents", "de vos abonnements"), so "Chargement{v}…" reads "Chargement des agents…".
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
| critical path | chemin critique |
| baseline | référence |
| earned value | valeur acquise |
| what-if | simulation |
| milestone | jalon |
| triage | tri |
| suggestion | suggestion |
| tag | étiquette |
| token | jeton |
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
| resolve, resolved | résoudre, résolu |
| dashboard, widget | tableau de bord, widget |
| report | rapport |
| app | application |
| handler (of an app) | gestionnaire |

**Checking French.** The checks above, then `e2e/french.spec.ts`: a person of its own signs in through a French browser, and the issues, an issue, the inbox, the profile and a problem on the sign-in page are shot in light, in dark and at 390px. A reviewer who reads French walks the same pages and the emails (`server.*` keys), and reads each prefix's pieces together, as they join: the ledger (`activity.ledgerEntry.*`), a rule's sentence (`rules.words.*`) and the notification titles (`server.notify.*`).
