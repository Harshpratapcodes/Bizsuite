import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { KhataReport } from "@bizsuite/contracts";
import { api } from "../api";
import { useAuth } from "../auth";
import { visibleApps } from "../apps";
import { UserMenu } from "../components/UserMenu";
import { inr } from "./Khata";

/** Home launcher (Bizesuite design): tinted app tiles under a white topbar. */
export function HomeScreen() {
  const { user } = useAuth();

  // The khata total is the number dad's whole system runs on — show it live.
  const khata = useQuery({
    queryKey: ["khata"],
    queryFn: () => api.get<KhataReport>("/api/accounting/reports/khata"),
  });

  return (
    <div className="launcher-screen">
      <header className="topbar">
        <div className="brand">
          <span className="brand-chip">◈</span>
          <span>BizSuite</span>
        </div>
        <div className="topbar-spacer" />
        <UserMenu />
      </header>
      <div className="launcher-scroll">
        <div className="launcher">
          {visibleApps(user).map((a) => {
            const status = a.id === "khata" && khata.data
              ? `${inr(khata.data.totalReceivable)} receivable`
              : a.desc;
            if (a.soon) {
              return (
                <div key={a.id} className="tile soon" aria-disabled="true">
                  <div className="tile-icon" style={{ background: a.tint, color: a.hue }}>{a.glyph}</div>
                  <div className="tile-name">{a.name}</div>
                  <div className="tile-status">Coming soon · {a.desc}</div>
                </div>
              );
            }
            return (
              <Link key={a.id} to={a.path} className="tile" aria-label={a.name}>
                <div className="tile-icon" style={{ background: a.tint, color: a.hue }}>{a.glyph}</div>
                <div className="tile-name">{a.name}</div>
                <div className="tile-status">{status}</div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
