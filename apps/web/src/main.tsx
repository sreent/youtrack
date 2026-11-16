/**
 * The page's first script: it loads its person's catalog, then the app, so every word the app says
 * is in their language from its first frame (docs/architecture.md, D49).
 */
import { startI18n } from './i18n';

void startI18n().then(() => import('./root'));
