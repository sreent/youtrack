# Questions for native speakers

German, Spanish, French and Japanese were each translated, then read again whole by a reviewer who hadn't written it, working from English, the code and [translating.md](translating.md). That reviewer was a model, not a native speaker. The second reads changed 1,371 messages: 502 in German, 316 in Spanish, 299 in French and 254 in Japanese. The same reviewers then translated the 909 messages added since (the server's problems, `problem.*`, and the messages that replaced English the catalogs couldn't say), and those have had no second read. Then 103 more (what the server words for a page: a rule's preview and runs, a commit's note, why a chat subscription stopped) were written in every language by the developers who added them, then read by the reviewers. Each language that came later says at the head of its section how it was written.

On 24 November 2026 a model editor for each language settled the questions this page then held, about a thousand across the ten languages. Each decided from how the interfaces its readers use every day say a thing (Microsoft's, Apple's and Google's, GitHub's, GitLab's and Atlassian's documentation, the language's style guides), applied each decision across its catalog, and put each term it settled in its language's table in [translating.md](translating.md). None of those editors is a native speaker either.

What follows is what's left, by language: what needs a native speaker's ear, or the code to change. Each item names its key, says what the catalog says now, and asks the question.

To settle one, change the message in its catalog and take the item off this page. If it's a term, change it everywhere and put it in the language's terms table in [translating.md](translating.md). `pnpm --filter @a4a/web check:words` checks that every message still parses, with English's placeholders.

## German

Its open questions were settled by a model editor's pass on 24 November 2026: 91 settled, 0 left for a native speaker.

## Spanish

One Spanish for Spain and Latin America, as [translating.md](translating.md) says.

Its open questions were settled by a model editor's pass on 24 November 2026: 89 settled, 1 answered since by a change to the code (the burndown's list has a word of its own), and 4 questions for the product moved to [the end of this page](#for-the-product-not-a-language).

## French

Its open questions were settled by a model editor's pass on 24 November 2026: 91 settled, 1 answered since by the code (a4a elides "de" before a value), and 4 questions for the product moved to [the end of this page](#for-the-product-not-a-language).

## Japanese

Its open questions were settled by a model editor's pass on 24 November 2026: 87 settled, and 2 questions for the product moved to [the end of this page](#for-the-product-not-a-language).

## Portuguese

`pt.json` was written for Brazil in one pass by a model working from English, then edited by a model for natural Brazilian phrasing. It is now Portugal's Portuguese: a third pass, by a model again and not a native speaker, converted every message to Portuguese as Portugal's software writes it (Microsoft's and Google's interfaces in Portugal the model), read part by part in the order people see them: sign-in and the frame, issues, boards, the inbox and its emails, the help desk, the problems, then the rest. No one from Portugal has read it. These are the choices a native speaker should settle.

Its open questions were settled by a model editor's pass on 24 November 2026: 73 settled, 1 left for a native speaker.

Left for a native speaker:

- **Quotation marks** are «…», with “…” inside, as Portugal's print and the EU's Portuguese style write them, while Microsoft's Portuguese style guide quotes a word on screen with “…”, as Apple's and Google's interfaces in Portugal mostly do. Both are Portugal's. Meanwhile the catalog keeps «…» (some 260 messages, `ui.quoted` among them): it is Portugal's own mark, and it keeps a quoted name apart from the straight quotes of a command someone types. Which do Portuguese readers expect on a page?

Needs the code to change:

- **The reader handed in as a name** still says *Você* in the portal's thread and in a query's "me" (`page.portal.you` in `page.portal.asked` and `page.portal.messageHead`, `page.track.you`, `page.track.youAsked`, `server.query.you`): one value stands as a verb's subject ("<t0>Você</t0> escreveu"), after a preposition ("atribuídos a você, anna") and alone ("Reporter: você"), where Portugal's Portuguese says no pronoun, *si* and *eu*. "Eu" can't stand in for it ("Eu escreveu"), so *Você*, the one form that fits every place, stays until the code says whether a value is the reader (a select, `{who, select, you {…} other {…}}`) and each place takes its own form. The suggestion card, whose sentences the catalog could turn, says "Aplicada por si." already.

## Korean

Korean was translated in one pass, from English, the code and [translating.md](translating.md), by a model working alone, then edited twice by models for natural phrasing (the lists under "Edited for natural phrasing"); no native speaker has read it. Its messages were checked by machine for what a catalog must keep (every placeholder, tag, select case and `#`, Korean's one plural category) and read in a browser through the sign-in page, the issues, an issue, the inbox and the profile.

Its open questions were settled by a model editor's pass on 24 November 2026: 105 settled, 1 answered since by a change to the code (whom a rule told, "Anna, Ben 외 3명"), 1 left for a native speaker and 1 that needs Ocean's stylesheet.

- **What a requester reads** (the help form, the portal, a request's page, the desk's emails) asks with “-어 주세요”, and the emails take the honorific for the reader's own acts (“본인이 요청하지 않으셨다면 이 메일은 무시하셔도 됩니다”), where the team's pages ask with “-세요”. A company whose support writes 해요체 may want that for its customers; the catalog says “-어 주세요” meanwhile, as Korean support mostly writes it.
- **Needs code**: the browser breaks Korean between any two syllables (CSS `word-break: normal`), so a word can split across lines (“선택하/세요”). Korean typesetting breaks at spaces: Ocean's `:lang(ko)` wants `word-break: keep-all` with `overflow-wrap: anywhere`, so a long unspaced word still fits a phone.

## Simplified Chinese

The whole catalog was translated in one pass by a model, working from English, the code, [translating.md](translating.md) and the other catalogs, then edited twice by models for natural phrasing (the lists under "Edited for natural phrasing"); no native speaker has read it. Everything below is open.

Its open questions were settled by a model editor's pass on 24 November 2026: 103 settled, and its last 3 answered since by changes to the code: no space beside a value written in Chinese, 和 and 或 spaced beside a Latin item, and Traditional Chinese readers given their next language (D49).

## Vietnamese

Translated whole by one model, from English, the code and [translating.md](translating.md), then edited twice by models for natural phrasing (the lists under "Edited for natural phrasing"), with no native speaker yet.

Its open questions were settled by a model editor's pass on 24 November 2026: 113 settled, and 1 question for the product moved to [the end of this page](#for-the-product-not-a-language).

## Indonesian

Indonesian was translated in one pass, by a model working from English, the code and [translating.md](translating.md). A second and a third read, by models again, edited it for natural phrasing (the lists under "Edited for natural phrasing"); no native speaker has read it yet.

Its open questions were settled by a model editor's pass on 24 November 2026: 110 settled, 1 left for a native speaker.

- **The help desk's emails** are a company's voice to its customers, which a desk may want warmer or more formal: meanwhile they greet as Indonesia's online services write, "Halo {name}, permintaan Anda sudah kami terima." (`server.helpdesk.received`), and say *Anda*, with no *Yth.* or *Bapak/Ibu* (`server.helpdesk.*`, `server.portal.*`), since a4a knows neither who reads them nor how formal the company is.

## Thai

Thai was written in one pass by a writer who isn't a native speaker, as the others were; nobody who reads Thai daily has checked it. The Thai section of [translating.md](translating.md#thai) gives the reasons for each choice below.

Its open questions were settled by a model editor's pass on 24 November 2026: 111 settled, and its last answered in part since by the code: a value that is one of the catalog's own words joins as a word, and what's left of it, a name beside a pause, is under [What a catalog can't say yet](#what-a-catalog-cant-say-yet).

## For the product, not a language

Several languages' editors met these, and none has words of its own to settle: each asks what a4a should do.

- **A post that changes in place** (D42): should a channel see that a post was edited? Teams and Slack mark an edited message themselves; the editors who answered thought that's enough.
- **The portal's language** (D63): a requester's emails and the portal follow their browser's language, kept on the requester. Should the portal offer a choice? Many people in Vietnam run their phone and browser in English and read Vietnamese first, so one would help there; the Chinese and Japanese editors thought the browser's enough.
- **A group's member copied on its new requests** (D56): their email says only that they're copied, as any CC's does. Should it say it's because of their group (`server.helpdesk.cc.whyAnswer`, `whyLink`), with a message of its own?
- **The customers' directory** on a group's form (D56) lists names alone. Japanese and Chinese companies' names are long and alike (「〇〇システム株式会社」, 「〇〇システムズ株式会社」), so the domains beside each would tell them apart.

## What a catalog can't say yet

These need the code to change, not a catalog:

- **A field's or state's gender**: a message that agrees with `{field}`, `{state}` or `{close}` assumes one.
- **Notes kept before a4a kept their words**: a commit's command note, a rule's run, a build's note and why a chat subscription, channel or workspace stopped, written before migrations `0028_build_notes` and `0029_kept_notes`, stay in the English they were kept in. New ones are said in each reader's language.
- **Whether a name is Thai**: Thai sets a Latin value off with a space and joins a Thai one, but its space is also its pause, and a name often ends a clause or a sentence: 165 messages put a sentence's pause beside a value (“ยังไม่ได้ตั้งงบประมาณให้ {name} ตั้งได้ใน…”). So a4a joins only a value that is one of the catalog's own one-word messages (“คัดลอกโทเค็นแล้ว”, “ทีมงานตอบกลับ…”, D49), and a person or a project named in Thai keeps the spaces the catalog gives a name: “คุณ สมชาย”, `server.helpdesk.received`. A catalog that marked its pauses beside a value apart from its other spaces would let a4a join a Thai name too.
- **Korean's particles after a Latin word**: a4a chooses a particle after Hangul and digits (`koreanParticles` in `packages/shared/src/i18n.ts`), but can't hear how a Latin name, state or key ends, so there Korean keeps both ways (을(를), 이(가)). A value passed with whether it ends in a consonant would let Korean choose the one it needs.
- **Portuguese's contractions with a value**: a product's or a desk's name takes an article in Portuguese ("do GitHub", "no centro de apoio de X"). The catalog writes the article into the message, so it assumes a masculine product (identity providers, trackers, chat platforms) and leaves the desk's name without one, so each message says "ao", "no" or "do" before it (`server.helpdesk.deskOf`, `server.portal.deskOf`).
