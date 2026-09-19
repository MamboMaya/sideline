import { useEffect, useState } from "react";
import { assetUrl } from "../lib/assets";
import { openAsset } from "../lib/commands";

// One screenshot thumbnail. A ref whose file is gone (hand-deleted, purged)
// renders as a small "missing" chip instead of a broken image.
function Thumb({ rel }: { rel: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let live = true;
    assetUrl(rel).then(
      (url) => live && setSrc(url),
      () => live && setMissing(true),
    );
    return () => {
      live = false;
    };
  }, [rel]);

  if (missing)
    return <span className="thumb thumb-missing">image missing</span>;
  return (
    <button
      type="button"
      className="thumb"
      title="Open screenshot"
      onClick={(e) => {
        e.stopPropagation();
        openAsset(rel);
      }}
    >
      {src && <img src={src} alt="screenshot" />}
    </button>
  );
}

// The screenshots attached to a note (inbox.ts's splitBodyImages), as a
// thumbnail strip under the body — shared by all three card kinds. Click
// opens the full-size image in Preview.
export function BodyImages({ images }: { images: string[] }) {
  if (images.length === 0) return null;
  return (
    <div className="thumbs">
      {images.map((rel) => (
        <Thumb key={rel} rel={rel} />
      ))}
    </div>
  );
}
