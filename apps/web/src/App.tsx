import { BrowserRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider, RequireAuth } from "@/lib/auth";
import { ThemeProvider } from "@/lib/theme";

// Pages
import LandingPage from "@/pages/landing";
import LoginPage from "@/pages/login";
import AuthCallbackPage from "@/pages/auth-callback";
import PublicFormPage from "@/pages/public-form";
import NotFoundPage from "@/pages/not-found";
import DashboardPage from "@/pages/dashboard";
import FormBuilderPage from "@/pages/form-builder";
import SubmissionsPage from "@/pages/submissions";
import EndpointsPage from "@/pages/endpoints";
import ResponsesPage from "@/pages/responses";
import DeliveriesPage from "@/pages/deliveries";

// Layout
import Layout from "@/components/layout";
import { ApiHealthGate } from "@/components/api-health-gate";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

export default function App() {
  return (
    <ThemeProvider>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            {/* Always available — served from the CDN, no backend needed.
                /login is here (NOT behind the gate): the Cognito/Google flow is
                independent of the API, and it MUST render while the box is down
                so a visitor can sign in — signing in is what fires the wake. */}
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/auth/callback" element={<AuthCallbackPage />} />

            {/* Backend-dependent routes sit behind a health gate: if the API
                (behind the tunnel) is down or starting up, these render a
                friendly reconnecting page instead of breaking. */}
            <Route element={<ApiHealthGate />}>
              <Route path="/forms/:slug" element={<PublicFormPage />} />
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
                <Route path="responses" element={<ResponsesPage />} />
                <Route path="endpoints" element={<EndpointsPage />} />
                <Route path="deliveries" element={<DeliveriesPage />} />
              </Route>
            </Route>

            {/* Catch-all */}
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </BrowserRouter>
        <Toaster />
      </AuthProvider>
    </QueryClientProvider>
    </ThemeProvider>
  );
}
