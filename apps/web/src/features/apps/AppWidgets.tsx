import type { AppExtensionPoint } from '@a4a/shared';
import { Link, useParams } from 'react-router';
import { ErrorNote, Loading, PageHead } from '../../components/States';

import { useAppExtensions, type AppPlace } from './api';
import { AppFrame } from './AppFrame';

/** The widgets apps draw at a place (D48): nothing at all where none does. */
export function AppWidgets({ at, ...place }: { at: AppExtensionPoint } & AppPlace) {
  const ext = useAppExtensions(at, place);
  if (!ext.data?.length) return null;
  return (
    <>
      {ext.data.map((e) => (
        <AppFrame key={`${e.app}/${e.name}`} ext={e} place={place} />
      ))}
    </>
  );
}

/** An app's page of its own, from the main menu. */
export function AppPage() {
  const { app = '', widget = '' } = useParams();
  const ext = useAppExtensions('main-menu');
  const found = ext.data?.find((e) => e.app === app && e.name === widget);
  return (
    <>
      <PageHead title={found?.title ?? 'App'} crumbs={found ? <span>{found.appTitle}</span> : <Link to="/issues">Issues</Link>} />
      {ext.isLoading ? <Loading what="the app" /> : null}
      {ext.error ? <ErrorNote error={ext.error} /> : null}
      {ext.data && !found ? <p className="note">No app shows a page here: it may have been turned off or removed.</p> : null}
      {found ? <AppFrame ext={found} place={{}} /> : null}
    </>
  );
}
