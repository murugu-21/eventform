import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";

export default function LandingPage() {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8 text-center">
      <h1 className="text-4xl font-bold tracking-tight mb-4">Eventform</h1>
      <p className="text-muted-foreground text-lg mb-8 max-w-md">
        Forms in. Webhooks out. Build a form, collect submissions, and fan them
        out to your webhooks automatically.
      </p>
      <Button onClick={() => void navigate("/login")}>
        Sign in
      </Button>
    </div>
  );
}
