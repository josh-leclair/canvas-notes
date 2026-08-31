import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { User } from "../api/types";
import { useAuth } from "../auth";
import Logo from "../components/Logo";
import "./authForms.css";

export default function Setup() {
  const { bootstrap, setUser, refreshBootstrap } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const user = await api.post<User>("/api/auth/register", {
        email,
        password,
        display_name: displayName,
        invite_code: null,
      });
      setUser(user);
      await refreshBootstrap();
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <Logo size={30} />
          <h1>Set up {bootstrap?.instance_name ?? "Canvas"}</h1>
        </div>
        <p className="auth-lede">
          Create the first account. It becomes the admin, and open registration
          closes right after — everyone else joins by invite.
        </p>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Display name
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
        </label>
        {error && <div className="auth-error">{error}</div>}
        <button className="primary" type="submit">
          Create admin account
        </button>
      </form>
    </div>
  );
}
