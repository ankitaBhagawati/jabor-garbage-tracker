// What a municipality admin sees after signing in, until the dashboard is built.
type Props = {
  session: { email: string; role: string; municipality: { name: string; slug: string } | null };
  onSignOut: () => void;
};

export default function MunicipalityLanding({ session, onSignOut }: Props) {
  return (
    <div className="slide-in" style={{ maxWidth: 560, margin: "40px auto", padding: "0 16px" }}>
      <div className="card" style={{ padding: 24 }}>
        <p style={{ color: "#3C4A42", fontSize: 12, fontWeight: 800, letterSpacing: ".06em", marginBottom: 6 }}>JABOR ADMIN</p>
        <h1 style={{ fontSize: 24, fontWeight: 900, letterSpacing: "-0.03em", marginBottom: 14 }}>
          {session.municipality?.name || "Your municipality"}
        </h1>
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 12, rowGap: 6, fontSize: 14, marginBottom: 20 }}>
          <dt style={{ color: "#3C4A42" }}>Role</dt>
          <dd style={{ fontWeight: 700 }}>Municipality admin</dd>
          <dt style={{ color: "#3C4A42" }}>Signed in as</dt>
          <dd style={{ overflowWrap: "anywhere" }}>{session.email}</dd>
        </dl>
        <p style={{ fontSize: 15, marginBottom: 20 }}>Dashboard coming soon.</p>
        <button className="btn-s" onClick={onSignOut}>Sign Out</button>
      </div>
    </div>
  );
}
