import { BrowserRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider, RequireAuth } from "@/lib/auth";

// Pages
import LandingPage from "@/pages/landing";
import LoginPage from "@/pages/login";
import PublicFormPage from "@/pages/public-form";
import NotFoundPage from "@/pages/not-found";
import DashboardPage from "@/pages/dashboard";
import FormBuilderPage from "@/pages/form-builder";
import SubmissionsPage from "@/pages/submissions";
import EndpointsPage from "@/pages/endpoints";
import DeliveriesPage from "@/pages/deliveries";

// Layout
import Layout from "@/components/layout";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            {/* Public routes */}
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/f/:slug" element={<PublicFormPage />} />

            {/* Catch-all */}
            <Route path="*" element={<NotFoundPage />} />

            {/* Authenticated app shell */}
            <Route
              path="/app"
              element={
                <RequireAuth>
                  <Layout />
                </RequireAuth>
              }
            >
              <Route index element={<DashboardPage />} />
              <Route path="forms/:id" element={<FormBuilderPage />} />
              <Route path="forms/:id/submissions" element={<SubmissionsPage />} />
              <Route path="endpoints" element={<EndpointsPage />} />
              <Route path="deliveries" element={<DeliveriesPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
        <Toaster />
      </AuthProvider>
    </QueryClientProvider>
  );
}
