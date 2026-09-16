import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './lib/session';
import { LoadingState } from './components/ui';
import { SignInPage } from './routes/SignIn';
import { PortfolioOverview } from './routes/PortfolioOverview';
import { PropertyWorkspace } from './routes/PropertyWorkspace';
import { LeaseDetail } from './routes/LeaseDetail';
import { ImportCenter } from './routes/ImportCenter';
import { ReconciliationWorkbench } from './routes/ReconciliationWorkbench';
import { ExceptionWorkspace } from './routes/ExceptionWorkspace';
import { CloseWorkspace } from './routes/CloseWorkspace';
import { SubledgerExplorer } from './routes/SubledgerExplorer';
import { AuditExplorer } from './routes/AuditExplorer';
import { Administration } from './routes/Administration';

interface NavItem {
  to: string;
  label: string;
  /** Hidden unless the viewer holds this action. */
  action?: string;
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Portfolio', action: 'dashboard:read' },
  { to: '/properties', label: 'Properties', action: 'property:read' },
  { to: '/imports', label: 'Imports', action: 'import:read' },
  { to: '/reconciliation', label: 'Reconciliation', action: 'transaction:read' },
  { to: '/exceptions', label: 'Exceptions', action: 'exception:read' },
  { to: '/close', label: 'Close', action: 'close_snapshot:read' },
  { to: '/subledger', label: 'Subledger', action: 'journal:read' },
  { to: '/audit', label: 'Audit', action: 'audit:read' },
  { to: '/administration', label: 'Administration', action: 'org:manage_members' },
];

export function App() {
  const { viewer, loading, can } = useSession();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingState label="Starting Rentwell" />
      </div>
    );
  }

  if (!viewer) {
    // Everything except the sign-in page requires a session. The redirect
    // remembers where the user was heading.
    if (location.pathname !== '/sign-in') {
      return (
        <Navigate to="/sign-in" replace state={{ from: location.pathname + location.search }} />
      );
    }
    return <SignInPage />;
  }

  if (location.pathname === '/sign-in') {
    return <Navigate to="/" replace />;
  }

  const visibleNav = NAV_ITEMS.filter((item) => !item.action || can(item.action));

  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:shadow"
      >
        Skip to content
      </a>

      <Header navItems={visibleNav} />

      <main id="main" className="mx-auto max-w-[1600px] px-4 py-6">
        <Routes>
          <Route path="/" element={<PortfolioOverview />} />
          <Route path="/properties" element={<PortfolioOverview initialTab="properties" />} />
          <Route path="/properties/:propertyId" element={<PropertyWorkspace />} />
          <Route path="/leases/:leaseId" element={<LeaseDetail />} />
          <Route path="/imports" element={<ImportCenter />} />
          <Route path="/imports/:importId" element={<ImportCenter />} />
          <Route path="/reconciliation" element={<ReconciliationWorkbench />} />
          <Route path="/reconciliation/:transactionId" element={<ReconciliationWorkbench />} />
          <Route path="/exceptions" element={<ExceptionWorkspace />} />
          <Route path="/exceptions/:exceptionId" element={<ExceptionWorkspace />} />
          <Route path="/close" element={<CloseWorkspace />} />
          <Route path="/subledger" element={<SubledgerExplorer />} />
          <Route path="/audit" element={<AuditExplorer />} />
          <Route path="/administration" element={<Administration />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}

function Header({ navItems }: { navItems: readonly NavItem[] }) {
  const { viewer, signOut, seesWholePortfolio } = useSession();

  return (
    <header className="border-b border-ink-200 bg-white">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="rounded bg-ink-900 px-1.5 py-0.5 text-2xs font-bold uppercase tracking-widest text-white">
            RW
          </span>
          <span className="text-sm font-semibold text-ink-900">Rentwell</span>
          <span className="text-xs text-ink-400">{viewer?.organization.name}</span>
        </div>

        <nav aria-label="Primary" className="flex flex-1 flex-wrap items-center gap-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `rounded px-2.5 py-1.5 text-sm transition ${
                  isActive
                    ? 'bg-accent-100 font-medium text-accent-900'
                    : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-3 text-xs">
          <div className="text-right">
            <p className="font-medium text-ink-800">{viewer?.displayName}</p>
            <p className="text-ink-500">
              {viewer?.role.replace(/_/g, ' ').toLowerCase()}
              {/* Scope is stated, because "I can't see that property" is the
                  most common confusion in a multi-role system. */}
              {!seesWholePortfolio && ' · limited to assigned properties'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            className="rounded border border-ink-300 px-2 py-1 text-ink-700 hover:bg-ink-50"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

function NotFound() {
  return (
    <div className="panel p-8 text-center">
      <p className="text-sm font-medium text-ink-800">That page does not exist.</p>
      <NavLink to="/" className="mt-2 inline-block text-sm text-accent-700 underline">
        Back to the portfolio overview
      </NavLink>
    </div>
  );
}
