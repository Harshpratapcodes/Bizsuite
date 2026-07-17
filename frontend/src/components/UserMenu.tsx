import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";

/** Avatar → account menu (design: topbar avatar). Holds the logout action. */
export function UserMenu() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  if (!user) return null;
  const initials = user.fullName.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  async function logout() {
    await api.post("/api/auth/logout");
    // Full reload: guarantees zero cached business data survives the session.
    window.location.assign("/");
  }

  return (
    <div ref={boxRef} className="usermenu">
      <button type="button" className="avatar" aria-label="Account" onClick={() => setOpen((o) => !o)}>
        {initials}
      </button>
      {open && (
        <div className="menu menu-right">
          <div className="menu-head">
            <div className="menu-name">{user.fullName}</div>
            <div className="menu-sub">{user.roleName}</div>
          </div>
          <button type="button" className="menu-item" onClick={() => void logout()}>Log out</button>
        </div>
      )}
    </div>
  );
}
