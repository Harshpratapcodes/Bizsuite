import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccountNodeDto } from "@bizsuite/contracts";
import { api, friendlyMessage } from "../api";
import { useAuth, canManageAccounts } from "../auth";
import { inr } from "./Khata";

/**
 * Chart of Accounts — the ERPNext account tree. Group nodes roll up their
 * descendants' posted balances; ledger nodes link to their General Ledger.
 * Balances are debit-positive; shown as Dr/Cr on the account's natural side.
 */
function fmtBal(balance: string): { text: string; side: string } {
  const n = Number(balance);
  if (Math.round(n * 100) === 0) return { text: "—", side: "" };
  return { text: inr(Math.abs(n)), side: n > 0 ? "Dr" : "Cr" };
}

export function ChartOfAccountsScreen() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const canManage = canManageAccounts(user);

  const [showInactive, setShowInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [parentId, setParentId] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [isGroup, setIsGroup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.get<AccountNodeDto[]>("/api/accounting/accounts"),
  });

  const groups = useMemo(
    () => (accounts.data ?? []).filter((a) => a.isGroup).sort((a, b) => a.code.localeCompare(b.code)),
    [accounts.data]);

  // Build the tree order (depth-first by code) from the flat list.
  const rows = useMemo(() => {
    const all = accounts.data ?? [];
    const byParent = new Map<string, AccountNodeDto[]>();
    for (const a of all) {
      const k = a.parentId ?? "__root__";
      (byParent.get(k) ?? byParent.set(k, []).get(k)!).push(a);
    }
    const out: { node: AccountNodeDto; depth: number }[] = [];
    const walk = (parentKey: string, depth: number) => {
      const children = (byParent.get(parentKey) ?? []).sort((a, b) => a.code.localeCompare(b.code));
      for (const n of children) {
        if (!n.isActive && !showInactive) continue;
        out.push({ node: n, depth });
        walk(n.id, depth + 1);
      }
    };
    walk("__root__", 0);
    return out;
  }, [accounts.data, showInactive]);

  async function addAccount() {
    setBusy(true); setError(null);
    try {
      await api.post("/api/accounting/accounts", { parentId, code: code.trim(), name: name.trim(), isGroup });
      void qc.invalidateQueries({ queryKey: ["accounts"] });
      setAdding(false); setCode(""); setName(""); setIsGroup(false); setParentId("");
    } catch (e) { setError(friendlyMessage(e)); }
    finally { setBusy(false); }
  }

  async function archive(id: string) {
    setError(null);
    try {
      await api.post(`/api/accounting/accounts/${id}/archive`);
      void qc.invalidateQueries({ queryKey: ["accounts"] });
    } catch (e) { setError(friendlyMessage(e)); }
  }

  const ready = parentId && code.trim() && name.trim() && !busy;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Chart of accounts</h1>
          <p className="sub">Every posting lands here. Group accounts roll up their ledgers; click a ledger to see its entries.</p>
        </div>
        {canManage && !adding && <button className="btn-link" onClick={() => setAdding(true)}>＋ New account</button>}
      </div>

      {error && <div className="banner error" role="alert">{error}</div>}

      {adding && (
        <div className="card">
          <div className="row">
            <div>
              <label htmlFor="parent">Under group</label>
              <select id="parent" value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="" disabled>Select a group…</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.code} — {g.name} ({g.rootType})</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="code">Code</label>
              <input id="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. 5600" />
            </div>
          </div>
          <label htmlFor="name" style={{ marginTop: 12 }}>Account name</label>
          <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Electricity" />
          <label style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={isGroup} onChange={(e) => setIsGroup(e.target.checked)} style={{ width: "auto" }} />
            This is a group (holds other accounts, cannot be posted to)
          </label>
          <p className="sub" style={{ marginTop: 6 }}>The account type is inherited from the group you choose.</p>
          <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
            <button className="primary" style={{ marginTop: 0 }} disabled={!ready} onClick={() => void addAccount()}>
              {busy ? "Adding…" : "Add account"}
            </button>
            <button className="secondary" disabled={busy} onClick={() => { setAdding(false); setError(null); }}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card">
        <label style={{ marginTop: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} style={{ width: "auto" }} />
          Show archived accounts
        </label>
      </div>

      <div className="card">
        {accounts.isLoading && <p className="empty">Loading…</p>}
        {accounts.isError && <div className="banner error" role="alert">{friendlyMessage(accounts.error)}</div>}
        {accounts.data && (
          <table>
            <thead>
              <tr><th>Code</th><th>Account</th><th className="num">Balance</th>{canManage && <th></th>}</tr>
            </thead>
            <tbody>
              {rows.map(({ node, depth }) => {
                const bal = fmtBal(node.balance);
                return (
                  <tr key={node.id} className={node.isGroup ? "" : "rowlink"}
                      onClick={node.isGroup ? undefined : () => navigate(`/accounting/ledger/${node.id}`)}
                      style={{ opacity: node.isActive ? 1 : 0.5 }}>
                    <td>{node.code}</td>
                    <td style={{ paddingLeft: 8 + depth * 20, fontWeight: node.isGroup ? 600 : 400 }}>
                      {node.name}
                      {node.systemKey && <span className="badge" style={{ marginLeft: 8 }}>system</span>}
                      {!node.isActive && <span className="badge cancelled" style={{ marginLeft: 8 }}>archived</span>}
                    </td>
                    <td className="num">{bal.text}{bal.side && <span className="cell-hint"> {bal.side}</span>}</td>
                    {canManage && (
                      <td className="num" onClick={(e) => e.stopPropagation()}>
                        {node.isActive && !node.systemKey && (
                          <button className="secondary" style={{ marginTop: 0, padding: "2px 10px" }}
                                  onClick={() => void archive(node.id)}>Archive</button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
