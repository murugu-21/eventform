import { Link, NavLink, Outlet } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ModeToggle } from "@/components/mode-toggle";

const NAV_LINKS: { to: string; label: string; end?: boolean }[] = [
  { to: "/app", label: "Dashboard", end: true },
  { to: "/app/responses", label: "Responses" },
  { to: "/app/endpoints", label: "Endpoints" },
  { to: "/app/deliveries", label: "Deliveries" },
];

export default function Layout() {
  const { signOut } = useAuth();
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: () => api.me(),
  });

  return (
    <div className="flex min-h-screen flex-col">
      {/* Top nav. On mobile the nav drops to its own full-width row
          (order-last + w-full) and scrolls horizontally if it must;
          on sm+ everything sits on one row as before. */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 sm:px-6 py-3">
        <Link to="/app" className="font-semibold text-lg mr-2">
          EventForm
        </Link>
        <Separator orientation="vertical" className="h-5 hidden sm:block" />
        <nav className="order-last w-full -mx-1 px-1 sm:order-none sm:w-auto sm:mx-0 sm:px-0 flex gap-2 overflow-x-auto">
          {NAV_LINKS.map(({ to, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `text-sm px-3 py-1.5 rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  isActive
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 min-w-0">
          {me && (
            <span className="text-sm text-muted-foreground truncate max-w-32 hidden sm:inline">
              {me.name}
            </span>
          )}
          <ModeToggle />
          <Button variant="outline" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </header>

      {/* Page content */}
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
