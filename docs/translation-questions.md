# Questions for native speakers

German, Spanish, French and Japanese were each translated, then read again whole by a reviewer who hadn't written it, working from English, the code and [translating.md](translating.md). That reviewer was a model, not a native speaker. The second reads changed 1,371 messages: 502 in German, 316 in Spanish, 299 in French and 254 in Japanese. The same reviewers then translated the 909 messages added since (the server's problems, `problem.*`, and the messages that replaced English the catalogs couldn't say), and those have had no second read. Then 103 more (what the server words for a page: a rule's preview and runs, a commit's note, why a chat subscription stopped) were written in every language by the developers who added them, then read by the reviewers. Each language that came later says at the head of its section how it was written.

What follows is what the reviewers couldn't settle, by language. Each item names its key, says what the catalog says now, and asks the question.

To settle one, change the message in its catalog and take the item off this page. If it's a term, change it everywhere and put it in the language's terms table in [translating.md](translating.md). `pnpm --filter @a4a/web check:words` checks that every message still parses, with English's placeholders.

## German

Its open questions were settled by a model editor's pass on 18 November 2026: 91 settled, 0 left for a native speaker.

## Spanish

One Spanish for Spain and Latin America, as [translating.md](translating.md) says.

Its open questions were settled by a model editor's pass on 18 November 2026: 89 settled, 5 left for a native speaker.

Phrasing:

- `reports.burndown.added` is both a column of the burndown's table, an amount ("Agregado", as "Quitado" and "Terminado" are), and the kind of one issue's change in its list, where "Agregada" would agree with the issue as "Sacada", "Resuelta" and "Reabierta" now do. It needs a message for each use; meanwhile it says the column's "Agregado".

With the posts that change in place:

- Las publicaciones cambian en su sitio – sin palabras nuevas; una pregunta: ¿debería verse en el canal que se editó, o basta con el contenido reemplazado en silencio?

With the requester's own language:

- El idioma del solicitante: los correos siguen ahora el del navegador (guardado en el solicitante). Sin palabras nuevas; una pregunta: ¿la página del portal debería mostrar un selector de idioma, o basta el navegador?

With the group's members hearing of its requests:

- Los miembros se enteran de las solicitudes de su grupo (sin palabras nuevas); una pregunta: ¿debería la copia decir “de tu grupo” en el asunto o el texto?

With the customers' directory:

- El directorio de clientes (sin palabras nuevas); una pregunta: ¿la lista del formulario debe mostrar solo los nombres, o también los dominios como pista al lado?

## French

Its open questions were settled by a model editor's pass on 18 November 2026: 91 settled, 0 left for a native speaker.

Five wait on the code or the product, not on a native speaker's ear:

- `helpdesk.portalSignIn.throughSome`: "que des adresses de {list}", where {list} is bare domains ("de acme.com et acme.fr"). "de" before a value that begins with a vowel is the elision the translator is being taught (below, under What a catalog can't say yet); the message keeps "de" for it.
- **Posts that change in place** (no words of their own): should a channel see that a post was edited, or is its content replaced silently enough?
- **The requester's own language** (no words of their own): emails follow the browser's language, kept on the requester. Should the portal offer a choice of language, or is the browser's enough?
- **A group's members hearing of its requests** (no words of their own): should the copy say "de votre groupe" in its subject or its text? That would take a message of its own.
- **The customers' directory** (no words of their own): should the form's list show names alone, or each one's domains beside it?

## Japanese

Its open questions were settled by a model editor's pass on 18 November 2026: 87 settled, 2 left for a native speaker.

Both wait on the code as much as on an ear:

- **A group member's copy** (`server.helpdesk.cc.whyAnswer`, `whyLink`): a customer group's members now get its new requests' emails as CCs, so each says only 「{requester}様から{desk}へのリクエストのCCに入っているため、このメールをお送りしています。」. A Japanese customer who never asked to be copied expects to be told why: 「{group}のメンバーとして…」. That needs the server to say the copy is the group's, with the group's name; meanwhile it reads as any CC's, which is true of how a4a sends it.
- **The customers' directory** on a group's form lists names alone. Japanese companies' names are long and their group companies' alike (「〇〇システム株式会社」, 「〇〇システムズ株式会社」), so the domain beside each name would tell them apart. That needs the page to show it; meanwhile there are no words to change.

## Portuguese

`pt.json` was written for Brazil in one pass by a model working from English, then edited by a model for natural Brazilian phrasing. It is now Portugal's Portuguese: a third pass, by a model again and not a native speaker, converted every message to Portuguese as Portugal's software writes it (Microsoft's and Google's interfaces in Portugal the model), read part by part in the order people see them: sign-in and the frame, issues, boards, the inbox and its emails, the help desk, the problems, then the rest. No one from Portugal has read it. These are the choices a native speaker should settle.

Its open questions were settled by a model editor's pass on 18 November 2026: 73 settled, 1 left for a native speaker.

Left for a native speaker:

- **Quotation marks** are «…», with “…” inside, as Portugal's print and the EU's Portuguese style write them, while Microsoft's Portuguese style guide quotes a word on screen with “…”, as Apple's and Google's interfaces in Portugal mostly do. Both are Portugal's. Meanwhile the catalog keeps «…» (some 260 messages, `ui.quoted` among them): it is Portugal's own mark, and it keeps a quoted name apart from the straight quotes of a command someone types. Which do Portuguese readers expect on a page?

Needs the code to change:

- **The reader handed in as a name** still says *Você* in the portal's thread and in a query's "me" (`page.portal.you` in `page.portal.asked` and `page.portal.messageHead`, `page.track.you`, `page.track.youAsked`, `server.query.you`): one value stands as a verb's subject ("<t0>Você</t0> escreveu"), after a preposition ("atribuídos a você, anna") and alone ("Reporter: você"), where Portugal's Portuguese says no pronoun, *si* and *eu*. "Eu" can't stand in for it ("Eu escreveu"), so *Você*, the one form that fits every place, stays until the code says whether a value is the reader (a select, `{who, select, you {…} other {…}}`) and each place takes its own form. The suggestion card, whose sentences the catalog could turn, says "Aplicada por si." already.

## Korean

Korean was translated in one pass, from English, the code and [translating.md](translating.md), by a model working alone, then edited twice by models for natural phrasing (the lists under "Edited for natural phrasing"); no native speaker has read it. Its messages were checked by machine for what a catalog must keep (every placeholder, tag, select case and `#`, Korean's one plural category) and read in a browser through the sign-in page, the issues, an issue, the inbox and the profile.

Its open questions were settled by a model editor's pass on 18 November 2026: 105 settled, 3 left for a native speaker.

- **What a requester reads** (the help form, the portal, a request's page, the desk's emails) asks with “-어 주세요”, and the emails take the honorific for the reader's own acts (“본인이 요청하지 않으셨다면 이 메일은 무시하셔도 됩니다”), where the team's pages ask with “-세요”. A company whose support writes 해요체 may want that for its customers; the catalog says “-어 주세요” meanwhile, as Korean support mostly writes it.
- **Needs code**: a rule run's whom-it-told list reads “Anna Schmidt, Ben Okafor 및 다른 3명에게 알렸습니다” (`rules.run.toldOthers`), since the server joins “3 others” into the list as its last item. Korean says “Anna Schmidt, Ben Okafor 외 3명에게”, with no 및, which needs the others said beside the list rather than in it.
- **Needs code**: the browser breaks Korean between any two syllables (CSS `word-break: normal`), so a word can split across lines (“선택하/세요”). Korean typesetting breaks at spaces: Ocean's `:lang(ko)` wants `word-break: keep-all` with `overflow-wrap: anywhere`, so a long unspaced word still fits a phone.

## Simplified Chinese

The whole catalog was translated in one pass by a model, working from English, the code, [translating.md](translating.md) and the other catalogs, then edited twice by models for natural phrasing (the lists under "Edited for natural phrasing"); no native speaker has read it. Everything below is open.

Its open questions were settled by a model editor's pass on 18 November 2026: 103 settled, 3 left for a native speaker.

Phrasing:

- **Spaces around values**: the catalog spaces a placeholder as the Latin name, id or number it usually holds (「由 {name} 添加」), so a person named in Chinese reads 「以 王芳 身份」. See below.
- **Intl's lists beside a Latin word**: Intl joins a list with 和, 或 and 、 and no space, 「通知了 Anna Schmidt和Vera Viewer。」, 「邮件链接登录、密码登录和Okta 登录」, where the catalog spaces a Latin word everywhere else. Chinese spaces 和 and 或 beside one, so `listParts` would need to do for Chinese what it does for Thai: a code change. Meanwhile the lists read as Intl writes them. Intl's dates, durations and relative times keep their own spacing, as Chinese software prints them.
- **Traditional Chinese readers**: a browser asking for zh-TW, zh-HK or zh-Hant gets this catalog, since a4a matches a language by its first part, and Chrome lists a bare zh after zh-TW. Readers in Taiwan and Hong Kong read software in Traditional characters or in English, and many take Simplified for the wrong language, so until a4a has a Traditional catalog, `matchLocale` should pass them to their next language, the bare zh after a Traditional tag included: a code change. Meanwhile they get Simplified.

## Vietnamese

Translated whole by one model, from English, the code and [translating.md](translating.md), then edited twice by models for natural phrasing (the lists under "Edited for natural phrasing"), with no native speaker yet.

Its open questions were settled by a model editor's pass on 18 November 2026: 113 settled, 1 left for a native speaker.

With the requester's own language:

- **The portal's language** follows the requester's browser, as their emails do. Many people in Vietnam run their phone and browser in English and still read Vietnamese first, so a requester who writes in Vietnamese can be answered in English; a choice of language on the portal, kept on the requester, would let them say which. That needs the code. Meanwhile the catalog has nothing to change: a browser that asks for Vietnamese gets it.

## Indonesian

Indonesian was translated in one pass, by a model working from English, the code and [translating.md](translating.md). A second and a third read, by models again, edited it for natural phrasing (the lists under "Edited for natural phrasing"); no native speaker has read it yet.

Its open questions were settled by a model editor's pass on 18 November 2026: 110 settled, 1 left for a native speaker.

- **The help desk's emails** are a company's voice to its customers, which a desk may want warmer or more formal: meanwhile they greet as Indonesia's online services write, "Halo {name}, permintaan Anda sudah kami terima." (`server.helpdesk.received`), and say *Anda*, with no *Yth.* or *Bapak/Ibu* (`server.helpdesk.*`, `server.portal.*`), since a4a knows neither who reads them nor how formal the company is.

## Thai

Thai was written in one pass by a writer who isn't a native speaker, as the others were; nobody who reads Thai daily has checked it. The Thai section of [translating.md](translating.md#thai) gives the reasons for each choice below.

Its open questions were settled by a model editor's pass on 18 November 2026: 111 settled, 1 left for a native speaker.

Typography and phrasing:

- **A space on each side of a value whose script a4a can't know.** A name, an id or a Latin word takes one, and a piece the page translates joins as a word, but a few values are either: the copy button's piece (`common.copyButton.copied`, `common.copyButton.couldnTCopySelectIt`), so “คัดลอก {what} แล้ว” reads “คัดลอก URL แล้ว” and also “คัดลอก โทเค็น แล้ว”, and a requester's name after คุณ (`server.helpdesk.received`), “คุณ Ada” and also “คุณ สมชาย”. Meanwhile the catalog spaces them, which is right for a Latin value and only a pause for a Thai one. Joining them by script, as `listParts` does for lists, needs the code to say which a value is.

## What a catalog can't say yet

These need the code to change, not a catalog:

- **French can't elide before a name**: "de {name}" prints "de Ada", not "d’Ada", since the name is a value.
- **Spanish's "y" before an "i" sound**: `problem.command.valueOfFields` joins two field names with "y", which should be "e" when the second starts with an "i" sound. Field names are data. Intl's lists already say "e" there ("Priority e Importancia"); this message writes its "y" itself.
- **A field's or state's gender**: a message that agrees with `{field}`, `{state}` or `{close}` assumes one.
- **Notes kept before a4a kept their words**: a commit's command note, a rule's run, a build's note and why a chat subscription, channel or workspace stopped, written before migrations `0028_build_notes` and `0029_kept_notes`, stay in the English they were kept in. New ones are said in each reader's language.
- **Lists inside the server's problems**: the server joins what a problem lists with ", ": fields, values, roles, boards, sprints, projects, logins, a GitHub App's installations (`problem.issues.noSuchField`, `problem.values.unknownValue`, `problem.access.unknownRole`, `problem.vcs.githubApp.whichInstallation` and their like). Japanese and Chinese read 「acme (123), anna (456)」 where they would write 「、」. An issue's history shows a change to a multi-value field or to its tags joined the same way, as the server keeps the change (`packages/server/src/services/issues.ts`, and `presentValues` in `packages/server/src/services/values.ts`).
- **Whether a value is Chinese**: Chinese spaces a value written in Latin letters or digits and not one written in Chinese, and a catalog can't tell which a value is, so it spaces names, ids and numbers. A person or a project named in Chinese gets spaces it doesn't need: 「以 王芳 身份」.
- **Korean's particles after a Latin word**: a4a chooses a particle after Hangul and digits (`koreanParticles` in `packages/shared/src/i18n.ts`), but can't hear how a Latin name, state or key ends, so there Korean keeps both ways (을(를), 이(가)). A value passed with whether it ends in a consonant would let Korean choose the one it needs.
- **Portuguese's contractions with a value**: a product's or a desk's name takes an article in Portuguese ("do GitHub", "no centro de apoio de X"). The catalog writes the article into the message, so it assumes a masculine product (identity providers, trackers, chat platforms) and leaves the desk's name without one, so each message says "ao", "no" or "do" before it (`server.helpdesk.deskOf`, `server.portal.deskOf`).
