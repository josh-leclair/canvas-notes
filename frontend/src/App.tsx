import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import DialogHost from "./components/DialogHost";
import CanvasList from "./routes/CanvasList";
import CanvasPage from "./routes/CanvasPage";
import Login from "./routes/Login";
import Register from "./routes/Register";
import Settings from "./routes/Settings";
import Setup from "./routes/Setup";
import PublicLensPage from "./routes/PublicLensPage";
import MobileHome from "./routes/MobileHome";
import MobileBoard from "./routes/MobileBoard";
import useMobileLayout from "./hooks/useMobileLayout";

/** App-wide counterpart to the reversible container study. Turning this off
 * restores the established theme tokens without removing the palette work. */
const PALETTE_STUDY = true;

function Shell() {
  const { loading, user, bootstrap } = useAuth();
  const location = useLocation();
  const mobile = useMobileLayout();

  // Public lenses deliberately sit outside the account gate. The endpoint
  // still serves only a frozen, publisher-reviewed snapshot.
  if (location.pathname.startsWith("/p/")) {
    return (
      <Routes>
        <Route path="/p/:slug" element={<PublicLensPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  if (loading) {
    return null;
  }
  if (bootstrap?.needs_setup) {
    return (
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }
  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  if (mobile) {
    return (
      <Routes>
        <Route path="/" element={<MobileHome />} />
        <Route path="/c/:canvasId" element={<MobileBoard />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/" element={<CanvasList />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/c/:canvasId" element={<CanvasPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <div className={PALETTE_STUDY ? "app-palette-study" : undefined}>
        <Shell />
        <DialogHost />
      </div>
    </AuthProvider>
  );
}
