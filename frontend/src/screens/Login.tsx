import { useState, type FormEvent } from "react";
import { Login } from "@bizsuite/contracts";
import { api, friendlyMessage } from "../api";
import { useAuth } from "../auth";

export function LoginScreen() {
  const { refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = Login.safeParse({ email, password });
    if (!parsed.success) {
      setError("Enter a valid email and your password.");
      return;
    }
    setBusy(true);
    try {
      await api.post("/api/auth/login", parsed.data);
      refresh();
    } catch (err) {
      setError(friendlyMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={(e) => void onSubmit(e)}>
        <h1>BizSuite</h1>
        <p className="sub">Log in to continue</p>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="username" value={email}
               onChange={(e) => setEmail(e.target.value)} autoFocus />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" value={password}
               onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="banner error" role="alert">{error}</div>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Logging in…" : "Log in"}
        </button>
      </form>
    </div>
  );
}
