/** The help desk form's proof of work, off the page's thread (pow.ts starts it). */
import type { CaptchaChallenge } from '@a4a/shared';
import { findNumber } from './pow-search';

self.onmessage = async (e: MessageEvent<CaptchaChallenge>) => {
  self.postMessage({ number: await findNumber(e.data) });
};
