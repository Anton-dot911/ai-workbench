import { useEffect, useState } from "react";

const EVT = "wb:toast";
export const toast = (message: string): void => {
  window.dispatchEvent(new CustomEvent(EVT, { detail: message }));
};

export function Toaster() {
  const [msg, setMsg] = useState("");
  const [on, setOn] = useState(false);
  useEffect(() => {
    let t: number | undefined;
    const h = (e: Event) => {
      setMsg((e as CustomEvent<string>).detail);
      setOn(true);
      window.clearTimeout(t);
      t = window.setTimeout(() => setOn(false), 2800);
    };
    window.addEventListener(EVT, h);
    return () => {
      window.removeEventListener(EVT, h);
      window.clearTimeout(t);
    };
  }, []);
  return (
    <div className={"toast" + (on ? " on" : "")} role="status" aria-live="polite">
      {msg}
    </div>
  );
}
