import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth, canEnterOpening, canCreateInvoice, canCreateQuote } from "./auth";
import { LoginScreen } from "./screens/Login";
import { HomeScreen } from "./screens/Home";
import { Workspace } from "./components/Workspace";
import { KhataScreen } from "./screens/Khata";
import { PaymentNewScreen } from "./screens/PaymentNew";
import { OpeningBalanceScreen } from "./screens/OpeningBalance";
import { InvoicesScreen } from "./screens/Invoices";
import { InvoiceNewScreen } from "./screens/InvoiceNew";
import { InvoiceDetailScreen } from "./screens/InvoiceDetail";
import { QuotationsScreen } from "./screens/Quotations";
import { QuotationNewScreen } from "./screens/QuotationNew";
import { QuotationDetailScreen } from "./screens/QuotationDetail";

/**
 * Shell (Bizesuite design): "/" is the home launcher; every module screen
 * renders inside the Workspace topbar shell. RBAC still hides admin routes.
 */
export function App() {
  const { user, loading } = useAuth();

  if (loading) return <div className="login-wrap"><p>Loading…</p></div>;
  if (!user) return <LoginScreen />;

  return (
    <Routes>
      <Route path="/" element={<HomeScreen />} />
      <Route element={<Workspace />}>
        <Route path="/khata" element={<KhataScreen />} />
        <Route path="/payments/new" element={<PaymentNewScreen />} />
        <Route path="/invoices" element={<InvoicesScreen />} />
        {canCreateInvoice(user) && <Route path="/invoices/new" element={<InvoiceNewScreen />} />}
        {canCreateInvoice(user) && <Route path="/invoices/:id/edit" element={<InvoiceNewScreen />} />}
        <Route path="/invoices/:id" element={<InvoiceDetailScreen />} />
        <Route path="/quotations" element={<QuotationsScreen />} />
        {canCreateQuote(user) && <Route path="/quotations/new" element={<QuotationNewScreen />} />}
        {canCreateQuote(user) && <Route path="/quotations/:id/edit" element={<QuotationNewScreen />} />}
        <Route path="/quotations/:id" element={<QuotationDetailScreen />} />
        {canEnterOpening(user) && <Route path="/opening-balances" element={<OpeningBalanceScreen />} />}
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
