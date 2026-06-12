import googleSignInLight from "@/assets/google-signin.svg";
import googleSignInDark from "@/assets/google-signin-dark.svg";

/**
 * Google's OFFICIAL pre-rendered sign-in buttons, used unmodified per the
 * branding guidelines (light + dark variants from
 * https://developers.google.com/identity/branding-guidelines). The wrapper
 * only adds focus/hover affordances and theme-based variant selection.
 */
export function GoogleSignInButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Sign in with Google"
      className="mx-auto block rounded transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4285f4]"
    >
      <img src={googleSignInLight} alt="Sign in with Google" height={40} width={175} className="dark:hidden" />
      <img src={googleSignInDark} alt="" aria-hidden="true" height={40} width={175} className="hidden dark:block" />
    </button>
  );
}
