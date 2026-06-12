import { useState, type ChangeEvent, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GoogleSignInButton } from "@/components/google-signin-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth, AUTH_MODE } from "@/lib/auth";

const HANDLE_RE = /^[A-Za-z0-9_-]{1,64}$/;

export default function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!HANDLE_RE.test(handle)) {
      setError("Handle must be 1–64 characters: letters, digits, _ or -");
      return;
    }
    signIn(handle);
    void navigate("/app");
  }

  if (AUTH_MODE === "cognito") {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Sign in to Eventform</CardTitle>
            <CardDescription>
              Sign in with your Google account to continue.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <GoogleSignInButton onClick={() => void signIn()} />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in to Eventform</CardTitle>
          <CardDescription>
            Dev sign-in — enter any handle to get started.{" "}
            Google sign-in via Cognito is used in production builds.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="handle">Handle</Label>
              <Input
                id="handle"
                type="text"
                placeholder="e.g. alice"
                value={handle}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  setHandle(e.target.value);
                  setError(null);
                }}
                aria-label="Handle"
                autoFocus
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
            <Button type="submit" className="w-full">
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
