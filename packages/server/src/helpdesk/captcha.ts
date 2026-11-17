/**
 * A help desk form's proof of work (D30): no puzzle for a person, no third party, nothing the
 * page's policy has to let in. The server signs a challenge (a SHA-256 to find), the browser
 * finds the number that makes it with WebCrypto, and the server checks the answer and takes it
 * once. The scheme is ALTCHA's, so its numbers are bounded: a browser tries at most `maxnumber`.
 *
 * The server keeps nothing until an answer comes: the challenge's salt says when it expires and
 * which desk it's for, and its signature says the server made it. The answer is counted in the
 * help desk's shared throttle (one hit allowed), so it can't be sent twice, on any instance.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { CaptchaChallenge, CaptchaSolution } from '@a4a/shared';
import type { AppServices } from '../context';
import { sign, verify } from '../notify/state';
import { helpHit } from '../services/help-throttle';

/** How long a challenge stays good: a form left open longer gets a new one, solved again, when it's sent. */
export const CAPTCHA_TTL_MS = 30 * 60_000;
const PURPOSE = 'help-captcha';

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

export async function captchaChallenge(app: AppServices, desk: string, now = Date.now()): Promise<CaptchaChallenge> {
  const expires = Math.floor((now + CAPTCHA_TTL_MS) / 1000);
  const salt = `${randomBytes(12).toString('hex')}?expires=${expires}&desk=${desk.toUpperCase()}`;
  const maxnumber = app.config.helpdeskCaptchaMaxNumber;
  const challenge = sha256hex(`${salt}${randomInt(0, maxnumber + 1)}`);
  return { algorithm: 'SHA-256', salt, challenge, maxnumber, signature: await sign(app, PURPOSE, challenge) };
}

export type CaptchaVerdict = 'ok' | 'expired' | 'wrong' | 'used';

export async function checkCaptcha(app: AppServices, desk: string, answer: CaptchaSolution | undefined, now = Date.now()): Promise<CaptchaVerdict> {
  if (!answer) return 'wrong';
  const params = new URLSearchParams(answer.salt.slice(answer.salt.indexOf('?') + 1));
  const expires = Number(params.get('expires'));
  if (!answer.salt.includes('?') || params.get('desk') !== desk.toUpperCase() || !Number.isFinite(expires)) return 'wrong';
  if (!(await verify(app, PURPOSE, answer.challenge, answer.signature))) return 'wrong';
  if (sha256hex(`${answer.salt}${answer.number}`) !== answer.challenge) return 'wrong';
  if (expires * 1000 < now) return 'expired';
  // Once: the first answer is counted and allowed, any after it are over the limit.
  return (await helpHit(app.db, [['captcha', answer.challenge]])) ? 'used' : 'ok';
}
