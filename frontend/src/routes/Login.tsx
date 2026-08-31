import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { User } from "../api/types";
import { useAuth } from "../auth";
import Logo from "../components/Logo";
import "./authForms.css";

export default function Login() {
  const { setUser, bootstrap } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const user = await api.post<User>("/api/auth/login", { email, password });
      setUser(user);
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
          <h1>{bootstrap?.instance_name ?? "Canvas"}</h1>
        </div>
        <p className="auth-lede">Boards for thinking in space. Welcome back.</p>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <div className="auth-error">{error}</div>}
        <button className="primary" type="submit">
          Sign in
        </button>
        <p className="auth-foot">
          Have an invite? <a href="/register">Create an account</a>
        </p>
      </form>
    </div>
  );
}
