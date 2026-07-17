import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { appForPath, tabsForApp, visibleApps } from "../apps";
import { UserMenu } from "./UserMenu";

/**
 * App workspace shell (Bizesuite design): 56px topbar with the ⊞ app
 * switcher, the app name in its hue, section tabs, and the account menu.
 * The active app's hue/tint flow down as CSS variables so .primary buttons
 * and tabs pick up the app color.
 */
export function Workspace() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [switcher, setSwitcher] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const app = appForPath(location.pathname);
  const tabs = tabsForApp(app, user);

  useEffect(() => setSwitcher(false), [location.pathname]);

  return (
    <div className="workspace" style={{ "--hue": app.hue, "--tint": app.tint } as CSSProperties}>
      <header className="topbar">
        {/* Design behavior: CLICK ⊞ → all-apps home; hover shows quick-switch. */}
        <div ref={boxRef} className="switcher-box"
             onMouseEnter={() => setSwitcher(true)}
             onMouseLeave={() => setSwitcher(false)}>
          <button type="button" className="iconbtn" aria-label="All apps" title="All apps"
                  onClick={() => navigate("/")}>⊞</button>
          {switcher && (
            <div className="menu">
              {visibleApps(user).filter((a) => !a.soon).map((a) => (
                <Link key={a.id} to={a.path} className="menu-item">
                  <span className="menu-dot" style={{ background: a.tint, color: a.hue }}>{a.glyph}</span>
                  <span>{a.name}</span>
                </Link>
              ))}
              <Link to="/" className="menu-item menu-foot">⊞&ensp;All apps</Link>
            </div>
          )}
        </div>
        <div className="app-title" style={{ color: app.hue }}>{app.name}</div>
        {tabs.length > 0 && (
          <nav className="tabs">
            {tabs.map((t) => (
              <NavLink key={t.to} to={t.to} end={t.end} className="tab">{t.name}</NavLink>
            ))}
          </nav>
        )}
        <div className="topbar-spacer" />
        <UserMenu />
      </header>
      <main className="wsmain">
        <Outlet />
      </main>
    </div>
  );
}
