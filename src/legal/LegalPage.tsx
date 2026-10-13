import { useEffect } from "react";
import "./legal.css";
import { CONTACT_EMAIL, DOCS, PRIVACY, TERMS, UPDATED, type Doc } from "./content.ts";

const LOGO = "/jabor-logo-green-removebg-preview.png";

// /privacy and /terms: plain reading pages, outside the main app so they open fast and need no data.
export default function LegalPage({ doc }: { doc: Doc }) {
  useEffect(() => { document.title = `${doc.title} | Jabor`; window.scrollTo({ top: 0 }); }, [doc]);
  const other = doc === PRIVACY ? TERMS : PRIVACY;
  return (
    <div className="legal">
      <header className="legal-bar">
        <a className="legal-brand" href="/" aria-label="Jabor home">
          <img src={LOGO} alt="" width={34} height={34} />
          <span><strong>Jabor</strong><small>Assam Garbage Tracker</small></span>
        </a>
        <a className="legal-back" href="/">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
          Back to Jabor
        </a>
      </header>
      <main className="legal-main">
        <h1>{doc.title}</h1>
        <p className="legal-updated">Last updated: {UPDATED}</p>
        {doc.intro.map(text => <p key={text}>{text}</p>)}
        <nav className="legal-toc" aria-label="On this page">
          <h2>On this page</h2>
          <ol>{doc.sections.map((s, i) => <li key={s.title}><a href={`#s${i + 1}`}>{s.title}</a></li>)}</ol>
        </nav>
        {doc.sections.map((section, i) => (
          <section key={section.title} id={`s${i + 1}`} aria-labelledby={`h${i + 1}`}>
            <h2 id={`h${i + 1}`}>{i + 1}. {section.title}</h2>
            {section.paragraphs?.map(text => <p key={text}>{text}</p>)}
            {section.list && <ul>{section.list.map(item => <li key={item}>{item}</li>)}</ul>}
            {section.after?.map(text => <p key={text}>{text}</p>)}
          </section>
        ))}
      </main>
      <footer className="legal-foot">
        <nav aria-label="Legal pages">
          {DOCS.map(d => <a key={d.path} href={d.path} aria-current={d === doc ? "page" : undefined}>{d.title}</a>)}
          <a href={`mailto:${CONTACT_EMAIL}?subject=Jabor%20${encodeURIComponent(doc.title)}`}>Contact us</a>
        </nav>
        <p>Read the <a href={other.path}>{other.title}</a> too.</p>
      </footer>
    </div>
  );
}
