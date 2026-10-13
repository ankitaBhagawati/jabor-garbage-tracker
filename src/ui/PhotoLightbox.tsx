import { useEffect, useRef } from "react";
import "./lightbox.css";

// A photo, enlarged. A native modal dialog, so it sits above everything else (a report window too), keeps focus
// inside, and Esc closes it. A cross at the top right and a click outside the photo close it as well.
export default function PhotoLightbox({ url, onClose, alt = "Report photo, enlarged" }: { url: string; onClose: () => void; alt?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog ref={ref} className="jlightbox" aria-label="Photo" onClose={onClose} onClick={e => { if (e.target === ref.current) ref.current?.close(); }}>
      <button type="button" className="jlightbox-close" aria-label="Close photo" onClick={() => ref.current?.close()} autoFocus>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m5.5 5.5 13 13M18.5 5.5l-13 13" /></svg>
      </button>
      <img src={url} alt={alt} />
    </dialog>
  );
}
