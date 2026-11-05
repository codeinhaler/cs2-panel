export function LoginPage() {
  const error = new URLSearchParams(window.location.search).get("error");
  return (
    <div className="login">
      <div className="panel login-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </span>
          CS2 Panel
        </div>
        <h1>Sign in</h1>
        <p>Use the Steam account the Owner added to the team.</p>
        {error && (
          <div className="notice error" role="alert" style={{ margin: "16px 0" }}>
            {error}
          </div>
        )}
        <a className="btn primary steam-btn" href="/api/auth/steam">
          Sign in through Steam
        </a>
      </div>
    </div>
  );
}
