import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
import {
  Login,
  VerifyEmail,
  Registration,
  ResetPassword,
  ApiErrorWatcher,
  TwoFactorScreen,
  RequestPasswordReset,
} from '~/components/Auth';
import MindStoneDiagnosticsView from '~/components/MindStone/DiagnosticsView';
import { MarketplaceProvider } from '~/components/Agents/MarketplaceContext';
import MindStoneOnboardingView from '~/components/MindStone/OnboardingView';
import MindStoneApprovalsView from '~/components/MindStone/ApprovalsView';
import MindStoneProvidersView from '~/components/MindStone/ProvidersView';
import MindStoneSettingsView from '~/components/MindStone/SettingsView';
import MindStonePersonasView from '~/components/MindStone/PersonasView';
import MindStoneSecretsView from '~/components/MindStone/SecretsView';
import MindStoneSkillsView from '~/components/MindStone/SkillsView';
import MindStoneMemoryView from '~/components/MindStone/MemoryView';
import AgentMarketplace from '~/components/Agents/Marketplace';
import { OAuthSuccess, OAuthError } from '~/components/OAuth';
import { AuthContextProvider } from '~/hooks/AuthContext';
import RouteErrorBoundary from './RouteErrorBoundary';
import StartupLayout from './Layouts/Startup';
import LoginLayout from './Layouts/Login';
import dashboardRoutes from './Dashboard';
import WithRum from '~/lib/rum/WithRum';
import ShareRoute from './ShareRoute';
import ChatRoute from './ChatRoute';
import Search from './Search';
import Root from './Root';

const AuthLayout = () => (
  <AuthContextProvider>
    <WithRum>
      <Outlet />
    </WithRum>
    <ApiErrorWatcher />
  </AuthContextProvider>
);

const loadInlinePromptsView = () =>
  import('~/components/Prompts/layouts/InlinePromptsView').then((m) => ({
    Component: m.default,
  }));

const loadSkillsView = () =>
  import('~/components/Skills/layouts/SkillsView').then((m) => ({
    Component: m.default,
  }));

const loadInsightsView = () =>
  import('~/components/Insights').then((m) => ({
    Component: m.default,
  }));

const loadProjectsView = () =>
  import('~/components/Projects').then((m) => ({
    Component: m.ProjectsView,
  }));

const loadProjectWorkspace = () =>
  import('~/components/Projects').then((m) => ({
    Component: m.ProjectWorkspace,
  }));

const baseEl = document.querySelector('base');
const baseHref = baseEl?.getAttribute('href') || '/';

export const router = createBrowserRouter(
  [
    {
      path: 'share/:shareId',
      element: <ShareRoute />,
      errorElement: <RouteErrorBoundary />,
    },
    {
      path: 'oauth',
      errorElement: <RouteErrorBoundary />,
      children: [
        {
          path: 'success',
          element: <OAuthSuccess />,
        },
        {
          path: 'error',
          element: <OAuthError />,
        },
      ],
    },
    {
      path: '/',
      element: <StartupLayout />,
      errorElement: <RouteErrorBoundary />,
      children: [
        {
          path: 'register',
          element: <Registration />,
        },
        {
          path: 'forgot-password',
          element: <RequestPasswordReset />,
        },
        {
          path: 'reset-password',
          element: <ResetPassword />,
        },
      ],
    },
    {
      path: 'verify',
      element: <VerifyEmail />,
      errorElement: <RouteErrorBoundary />,
    },
    {
      element: <AuthLayout />,
      errorElement: <RouteErrorBoundary />,
      children: [
        {
          path: '/',
          element: <LoginLayout />,
          children: [
            {
              path: 'login',
              element: <Login />,
            },
            {
              path: 'login/2fa',
              element: <TwoFactorScreen />,
            },
          ],
        },
        dashboardRoutes,
        {
          path: '/',
          element: <Root />,
          children: [
            {
              index: true,
              element: <Navigate to="/c/new" replace={true} />,
            },
            {
              path: 'c/:conversationId?',
              element: <ChatRoute />,
            },
            {
              path: 'search',
              element: <Search />,
            },
            {
              /** MindStone settings (MindStone-Agent #38, P2). The server route enforces admin. */
              path: 'mindstone',
              element: <MindStoneSettingsView />,
            },
            {
              /** MindStone guided setup (MindStone-Agent #38, P2). The server route enforces admin. */
              path: 'mindstone/onboarding',
              element: <MindStoneOnboardingView />,
            },
            {
              /** MindStone doctor and gateway logs (MindStone-Agent #86). The server route enforces admin. */
              path: 'mindstone/diagnostics',
              element: <MindStoneDiagnosticsView />,
            },
            {
              /** MindStone approvals (MindStone-Agent #84). The server route enforces admin. */
              path: 'mindstone/approvals',
              element: <MindStoneApprovalsView />,
            },
            {
              /** MindStone stored secrets (MindStone-Agent #88). The server route enforces admin. */
              path: 'mindstone/secrets',
              element: <MindStoneSecretsView />,
            },
            {
              /** MindStone Skill Builder (MindStone-Agent #104). The server route enforces admin. */
              path: 'mindstone/skills',
              element: <MindStoneSkillsView />,
            },
            {
              /** MindStone model providers (MindStone-Agent #126). The server route enforces admin. */
              path: 'mindstone/providers',
              element: <MindStoneProvidersView />,
            },
            {
              /** MindStone personas (MindStone-Agent #105). The server route enforces admin. */
              path: 'mindstone/personas',
              element: <MindStonePersonasView />,
            },
            {
              /** MindStone memory: setup and status (#53). The server route enforces admin. */
              path: 'mindstone/memory',
              element: <MindStoneMemoryView />,
            },
            {
              path: 'prompts',
              element: <Navigate to="/c/new" replace={true} />,
            },
            {
              /** Prompts are created from a dialog, so there is no "new" page to land on */
              path: 'prompts/new',
              element: <Navigate to="/c/new" replace={true} />,
            },
            {
              path: 'prompts/:promptId',
              lazy: loadInlinePromptsView,
            },
            {
              path: 'skills',
              lazy: loadSkillsView,
            },
            {
              path: 'insights',
              lazy: loadInsightsView,
            },
            {
              path: 'skills/new',
              lazy: loadSkillsView,
            },
            {
              path: 'skills/:skillId',
              lazy: loadSkillsView,
            },
            {
              path: 'skills/:skillId/edit',
              lazy: loadSkillsView,
            },
            {
              path: 'projects',
              lazy: loadProjectsView,
            },
            {
              path: 'projects/:projectId',
              lazy: loadProjectWorkspace,
            },
            {
              path: 'agents',
              element: (
                <MarketplaceProvider>
                  <AgentMarketplace />
                </MarketplaceProvider>
              ),
            },
            {
              path: 'agents/:category',
              element: (
                <MarketplaceProvider>
                  <AgentMarketplace />
                </MarketplaceProvider>
              ),
            },
          ],
        },
      ],
    },
  ],
  { basename: baseHref },
);
