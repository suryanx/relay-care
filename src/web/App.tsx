import { BrowserRouter, Route, Routes } from "react-router";
import { useSession } from "./lib/session";
import AppointmentForm from "./pages/AppointmentForm";
import Appointments from "./pages/Appointments";
import CareTeam from "./pages/CareTeam";
import ElderHome from "./pages/ElderHome";
import FollowUps from "./pages/FollowUps";
import Home from "./pages/Home";
import Invite from "./pages/Invite";
import MedicationForm from "./pages/MedicationForm";
import Medications from "./pages/Medications";
import NewProfile from "./pages/NewProfile";
import Notifications from "./pages/Notifications";
import ProfileView from "./pages/ProfileView";
import Register from "./pages/Register";
import Routines from "./pages/Routines";
import Schedule from "./pages/Schedule";
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
        <Route path="/profiles/:profileId/schedule" element={<Schedule />} />
        <Route path="/profiles/:profileId/medications" element={<Medications />} />
        <Route path="/profiles/:profileId/medications/new" element={<MedicationForm />} />
        <Route path="/profiles/:profileId/medications/:medicationId/edit" element={<MedicationForm />} />
        <Route path="/profiles/:profileId/routines" element={<Routines />} />
        <Route path="/profiles/:profileId/appointments" element={<Appointments />} />
        <Route path="/profiles/:profileId/appointments/new" element={<AppointmentForm />} />
        <Route path="/profiles/:profileId/appointments/:appointmentId/edit" element={<AppointmentForm />} />
        <Route path="/profiles/:profileId/notifications" element={<Notifications />} />
        <Route path="/profiles/:profileId/follow-ups" element={<FollowUps />} />
        <Route path="/profiles/:profileId/team" element={<CareTeam />} />
        <Route path="/invite" element={<Invite />} />
        <Route path="/elder" element={<ElderHome />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </BrowserRouter>
  );
}
