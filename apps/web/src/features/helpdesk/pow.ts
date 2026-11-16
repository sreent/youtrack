import type { CaptchaChallenge, CaptchaSolution } from '@a4a/shared';
import { findNumber } from './pow-search';

/**
 * Solve a help desk form's proof of work (D30): in a worker, so the page never stalls, or on the
 * page itself where a worker can't start. The worker is a file of this site's own, so the page's
 * policy lets it run. Resolves with what the form sends back.
 */
export function solveCaptcha(c: CaptchaChallenge): { done: Promise<CaptchaSolution>; stop(): void } {
  let worker: Worker | null = null;
  let stopped = false;
  const answer = (number: number | null): CaptchaSolution => {
    if (number === null) throw new Error("The check that you're not a bot can't be done here");
    return { salt: c.salt, challenge: c.challenge, signature: c.signature, number };
  };
  const onPage = () => findNumber(c, () => stopped).then(answer);
  const done = new Promise<CaptchaSolution>((resolve, reject) => {
    try {
      worker = new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      onPage().then(resolve, reject);
      return;
    }
    worker.onmessage = (e: MessageEvent<{ number: number | null }>) => {
      worker?.terminate();
      try {
        resolve(answer(e.data.number));
      } catch (err) {
        reject(err);
      }
    };
    worker.onerror = (e) => {
      e.preventDefault();
      worker?.terminate();
      onPage().then(resolve, reject);
    };
    worker.postMessage(c);
  });
  return {
    done,
    stop: () => {
      stopped = true;
      worker?.terminate();
    },
  };
}
