import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api";
import { useAuth, canEnterOpening } from "./auth";
import { LoginScreen } from "./screens/Login";
import { KhataScreen } from "./screens/Khata";
import { PaymentNewScreen } from "./screens/PaymentNew";
import { OpeningBalanceScreen } from "./screens/OpeningBalance";
import { InvoicesScreen } from "./screens/Invoices";

export function App() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <div className="login-wrap"><p>Loading…</p></div>;
  if (!user) return <LoginScreen />;

  async function logout() {
    await api.post("/api/auth/logout");
    // Full reload: guarantees zero cached business data survives the session,
    // and sidesteps TanStack's cleared-cache stale-observer gotcha entirely.
    window.location.assign("/");
  }

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">BizSuite</div>
        <NavLink to="/khata">Khata (dues)</NavLink>
        <NavLink to="/payments/new">Payment received</NavLink>
        <NavLink to="/invoices">Invoices</NavLink>
        {canEnterOpening(user) && <NavLink to="/opening-balances">Opening balances</NavLink>}
        <div className="spacer" />
        <div className="who">{user.fullName}<br />({user.roleName})</div>
        <button className="logout" onClick={() => void logout()}>Log out</button>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/khata" replace />} />
          <Route path="/khata" element={<KhataScreen />} />
          <Route path="/payments/new" element={<PaymentNewScreen />} />
          <Route path="/invoices" element={<InvoicesScreen />} />
          {canEnterOpening(user) && <Route path="/opening-balances" element={<OpeningBalanceScreen />} />}
          <Route path="*" element={<Navigate to="/khata" replace state={{ from: location }} />} />
        </Routes>
      </main>
    </div>
  );
}
