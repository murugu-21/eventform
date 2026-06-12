import googleSignInAsset from "@/assets/google-signin.svg";

/**
 * Google's OFFICIAL pre-rendered sign-in button, used unmodified per the
 * branding guidelines (downloadable asset from
 * https://developers.google.com/identity/branding-guidelines — light theme,
 * square variant). The asset must not be restyled; the wrapper only adds
 * focus/hover affordances around it.
 */
export function GoogleSignInButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Sign in with Google"
      className="mx-auto block rounded transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4285f4]"
    >
      <img src={googleSignInAsset} alt="Sign in with Google" height={40} width={175} />
    </button>
  );
}
