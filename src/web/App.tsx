import { BrowserRouter, Route, Routes } from "react-router";
import { useSession } from "./lib/session";
import ElderHome from "./pages/ElderHome";
import Home from "./pages/Home";
import NewProfile from "./pages/NewProfile";
import ProfileView from "./pages/ProfileView";
import Register from "./pages/Register";
import SignIn from "./pages/SignIn";

export default function App() {
  const { loading } = useSession();
  if (loading) return <p role="status" className="p-8">Loading Relay…</p>;
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/register" element={<Register />} />
        <Route path="/sign-in" element={<SignIn />} />
        <Route path="/profiles/new" element={<NewProfile />} />
        <Route path="/profiles/:profileId" element={<ProfileView />} />
        <Route path="/elder" element={<ElderHome />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </BrowserRouter>
  );
}
