import { useEffect, useState } from "react";

const QUERY = "(max-width: 760px), (pointer: coarse) and (max-width: 900px)";

export default function useMobileLayout() {
  const [mobile, setMobile] = useState(() => window.matchMedia(QUERY).matches);

  useEffect(() => {
    const media = window.matchMedia(QUERY);
    const update = () => setMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return mobile;
}
