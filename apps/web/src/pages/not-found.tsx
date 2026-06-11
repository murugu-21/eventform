import { Link } from "react-router";
import { Card } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";

export default function NotFoundPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="max-w-md w-full p-8 flex flex-col items-center gap-4 text-center">
        <div className="text-6xl font-bold text-muted-foreground/30">404</div>
        <h1 className="text-2xl font-bold">Page not found</h1>
        <p className="text-muted-foreground text-sm">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <Link to="/" className={buttonVariants({ variant: "default" })}>
          Go home
        </Link>
      </Card>
    </div>
  );
}
