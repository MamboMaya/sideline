import { readAsset } from "./commands";

// blob: URLs for inbox-assets/ thumbnails, one per ref for the life of the
// window. Cards re-render on every fs-watcher reload, so the cache is what
// keeps a screenshot from being re-read over IPC each time; assets are
// write-once (paste_clipboard_image never clobbers), so an entry can't go
// stale. A failed read is evicted so a later render retries.
const urls = new Map<string, Promise<string>>();

export function assetUrl(rel: string): Promise<string> {
  let url = urls.get(rel);
  if (!url) {
    url = readAsset(rel).then((bytes) =>
      URL.createObjectURL(new Blob([bytes], { type: "image/png" })),
    );
    url.catch(() => urls.delete(rel));
    urls.set(rel, url);
  }
  return url;
}
