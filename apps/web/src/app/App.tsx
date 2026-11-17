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
const WhiteboardsPage = lazy(() => import('../pages/WhiteboardsPage'));
const WhiteboardPage = lazy(() => import('../pages/WhiteboardPage'));
const SprintPlanningPage = lazy(() => import('../pages/SprintPlanningPage'));
const TimesheetPage = lazy(() => import('../pages/TimesheetPage'));
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
const ChatPage = lazy(() => import('../pages/ChatPage'));
const ChatLinkPage = lazy(() => import('../pages/ChatLinkPage'));
const BuildsPage = lazy(() => import('../pages/BuildsPage'));
const AdminPage = lazy(() => import('../pages/AdminPage'));
const GroupPage = lazy(() => import('../pages/GroupPage'));
const ProfilePage = lazy(() => import('../pages/ProfilePage'));
const ConfirmEmailPage = lazy(() => import('../pages/ConfirmEmailPage'));
const ArticlesPage = lazy(() => import('../pages/ArticlesPage'));
const DashboardPage = lazy(() => import('../pages/DashboardPage'));
const ReportsPage = lazy(() => import('../pages/ReportsPage'));
const ImportPage = lazy(() => import('../pages/ImportPage'));
const AppPage = lazy(() => import('../features/apps/AppWidgets').then((m) => ({ default: m.AppPage })));
const InboxPage = lazy(() => import('../pages/InboxPage'));
// Public: a help desk's form and a request's page, and where an email's unsubscribe link leads.
const HelpPage = lazy(() => import('../pages/HelpPage'));
const TrackPage = lazy(() => import('../pages/TrackPage'));
const PortalPage = lazy(() => import('../pages/PortalPage'));
const UnsubscribePage = lazy(() => import('../pages/UnsubscribePage'));
// Before the frame: an app that asks to work in a4a as someone (OAuth for MCP); it signs them in itself.
const OAuthConsentPage = lazy(() => import('../pages/OAuthConsentPage'));
// Guests (D37): the projects open to anyone, read without signing in.
const GuestHome = lazy(() => import('../pages/GuestPages').then((m) => ({ default: m.GuestHome })));
const GuestIssue = lazy(() => import('../pages/GuestPages').then((m) => ({ default: m.GuestIssue })));

export function App() {
  return (
    <Suspense
      fallback={<Loading />}
    >
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/help/:key" element={<HelpPage />} />
        <Route path="/request" element={<TrackPage />} />
        <Route path="/portal" element={<PortalPage />} />
        <Route path="/unsubscribe" element={<UnsubscribePage />} />
        <Route path="/oauth/authorize" element={<OAuthConsentPage />} />
        <Route path="/public" element={<GuestHome />} />
        <Route path="/public/issues/:id" element={<GuestIssue />} />
        <Route element={<RequireUser />}>
          <Route index element={<Navigate to="/issues" replace />} />
          <Route path="/inbox" element={<Page><InboxPage /></Page>} />
          <Route path="/issues" element={<Page><IssuesPage /></Page>} />
          <Route path="/issues/new" element={<Page><NewIssuePage /></Page>} />
          <Route path="/issues/:id" element={<Page><IssuePage /></Page>} />
          <Route path="/boards" element={<Page><BoardsPage /></Page>} />
          <Route path="/boards/:id" element={<Page><BoardPage /></Page>} />
          <Route path="/boards/:id/plan" element={<Page><SprintPlanningPage /></Page>} />
          <Route path="/whiteboards" element={<Page><WhiteboardsPage /></Page>} />
          <Route path="/whiteboards/:id" element={<Page><WhiteboardPage /></Page>} />
          <Route path="/timesheet" element={<Page><TimesheetPage /></Page>} />
          <Route path="/plan" element={<Page><PlanPage /></Page>} />
          <Route path="/plan/:project" element={<Page><PlanPage /></Page>} />
          <Route path="/plan/:project/:view" element={<Page><PlanPage /></Page>} />
          <Route path="/articles" element={<Page><ArticlesPage view="home" /></Page>} />
          <Route path="/articles/new" element={<Page><ArticlesPage view="new" /></Page>} />
          <Route path="/articles/:id" element={<Page><ArticlesPage view="article" /></Page>} />
          <Route path="/articles/:id/edit" element={<Page><ArticlesPage view="edit" /></Page>} />
          <Route path="/articles/:id/history" element={<Page><ArticlesPage view="history" /></Page>} />
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
          <Route path="/chat" element={<Page><ChatPage /></Page>} />
          <Route path="/chat/link" element={<Page><ChatLinkPage /></Page>} />
          <Route path="/builds/:key" element={<Page><BuildsPage /></Page>} />
          <Route path="/admin" element={<Page><AdminPage /></Page>} />
          <Route path="/groups/:id" element={<Page><GroupPage /></Page>} />
          <Route path="/me" element={<Page><ProfilePage /></Page>} />
          <Route path="/emails/confirm" element={<Page><ConfirmEmailPage /></Page>} />
          <Route path="/dashboard" element={<Page><DashboardPage /></Page>} />
          <Route path="/dashboard/:id" element={<Page><DashboardPage /></Page>} />
          <Route path="/reports" element={<Page><ReportsPage /></Page>} />
          <Route path="/reports/:kind" element={<Page><ReportsPage /></Page>} />
          <Route path="/import" element={<Page><ImportPage /></Page>} />
          <Route path="/import/:id" element={<Page><ImportPage /></Page>} />
          <Route path="/apps/:app/:widget" element={<Page><AppPage /></Page>} />
          <Route path="*" element={<Navigate to="/issues" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<Loading />}>{children}</Suspense>;
}
