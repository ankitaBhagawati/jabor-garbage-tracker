import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./icons.tsx";
import { ROLE_LABEL } from "./nav.ts";
import type { Session } from "./types.ts";

// The user icon in the header. It opens a small popover with who is signed in and the Sign out button.
// Closes on a press outside, on Esc, and when focus leaves it with Tab.
export default function UserMenu({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPress = (e: PointerEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPress);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPress); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div className="adm-usermenu" ref={wrapRef} onBlur={e => { if (open && !wrapRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false); }}>
      <button ref={buttonRef} type="button" className="adm-iconbtn" aria-label="Account" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(o => !o)}>
        <Icon name="user" size={22} />
      </button>
      {open && (
        <div id={id} className="adm-popover" role="dialog" aria-label="Account">
          <p className="adm-popover-email" title={session.email}>{session.email}</p>
          <p className="adm-popover-role">{ROLE_LABEL[session.role]}</p>
          <button type="button" className="btn-s adm-popover-out" onClick={() => { setOpen(false); onSignOut(); }}>
            <Icon name="signout" size={18} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
