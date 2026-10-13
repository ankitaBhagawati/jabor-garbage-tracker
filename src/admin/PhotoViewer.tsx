import { useEffect, useRef } from "react";
import { Icon } from "./icons.tsx";

// A report photo, enlarged. A native modal dialog, so it sits above everything else (the report drawer too), traps
// focus, and Esc closes it. The cross at the top right and a click outside the photo close it as well.
export default function PhotoViewer({ url, onClose }: { url: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog ref={ref} className="adm-lightbox" aria-label="Photo" onClose={onClose} onClick={e => { if (e.target === ref.current) ref.current?.close(); }}>
      <button type="button" className="adm-lightbox-close" aria-label="Close photo" onClick={() => ref.current?.close()} autoFocus><Icon name="close" size={22} /></button>
      <img src={url} alt="Report photo, enlarged" />
    </dialog>
  );
}
