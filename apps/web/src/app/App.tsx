import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { Loading } from '../components/States';
import { LoginPage, RequireUser, SetupPage } from './Auth';

// Pages load on demand so the first paint stays small.
const IssuesPage = lazy(() => import('../pages/IssuesPage'));
const IssuePage = lazy(() => import('../pages/IssuePage'));
const NewIssuePage = lazy(() => import('../pages/NewIssuePage'));
const BoardsPage = lazy(() => import('../pages/BoardsPage'));
const BoardPage = lazy(() => import('../pages/BoardPage'));
const PlanPage = lazy(() => import('../pages/PlanPage'));
const AssistantPage = lazy(() => import('../pages/AssistantPage'));
const SuggestionsPage = lazy(() => import('../pages/SuggestionsPage'));
const ProjectsPage = lazy(() => import('../pages/ProjectsPage'));
const ProjectPage = lazy(() => import('../pages/ProjectPage'));
const FieldsPage = lazy(() => import('../pages/FieldsPage'));
const ActivityPage = lazy(() => import('../pages/ActivityPage'));
const AgentsPage = lazy(() => import('../pages/AgentsPage'));
const WebhooksPage = lazy(() => import('../pages/WebhooksPage'));
const RulesPage = lazy(() => import('../pages/RulesPage'));
const IntegrationsPage = lazy(() => import('../pages/IntegrationsPage'));
const AdminPage = lazy(() => import('../pages/AdminPage'));
const ProfilePage = lazy(() => import('../pages/ProfilePage'));

export function App() {
  return (
    <Suspense
      fallback={<Loading />}
    >
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireUser />}>
          <Route index element={<Navigate to="/issues" replace />} />
          <Route path="/issues" element={<Page><IssuesPage /></Page>} />
          <Route path="/issues/new" element={<Page><NewIssuePage /></Page>} />
          <Route path="/issues/:id" element={<Page><IssuePage /></Page>} />
          <Route path="/boards" element={<Page><BoardsPage /></Page>} />
          <Route path="/boards/:id" element={<Page><BoardPage /></Page>} />
          <Route path="/plan" element={<Page><PlanPage /></Page>} />
          <Route path="/plan/:project" element={<Page><PlanPage /></Page>} />
          <Route path="/plan/:project/:view" element={<Page><PlanPage /></Page>} />
          <Route path="/assistant" element={<Page><AssistantPage /></Page>} />
          <Route path="/assistant/:id" element={<Page><AssistantPage /></Page>} />
          <Route path="/suggestions" element={<Page><SuggestionsPage /></Page>} />
          <Route path="/projects" element={<Page><ProjectsPage /></Page>} />
          <Route path="/projects/:key" element={<Page><ProjectPage /></Page>} />
          <Route path="/fields" element={<Page><FieldsPage /></Page>} />
          <Route path="/activity" element={<Page><ActivityPage /></Page>} />
          <Route path="/agents" element={<Page><AgentsPage /></Page>} />
          <Route path="/webhooks" element={<Page><WebhooksPage /></Page>} />
          <Route path="/rules" element={<Page><RulesPage /></Page>} />
          <Route path="/rules/:project" element={<Page><RulesPage /></Page>} />
          <Route path="/integrations" element={<Page><IntegrationsPage /></Page>} />
          <Route path="/admin" element={<Page><AdminPage /></Page>} />
          <Route path="/me" element={<Page><ProfilePage /></Page>} />
          <Route path="*" element={<Navigate to="/issues" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<Loading />}>{children}</Suspense>;
}
