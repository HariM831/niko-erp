/**
 * Shrink a photo in the browser before it is sent anywhere.
 *
 * A phone camera writes four to twelve megabytes a frame; a handwritten sheet
 * or a bill reads perfectly well at 1,600 pixels on the long edge and a
 * fraction of that. Done client-side so nothing large crosses a farm link,
 * and so the server's size ceiling is a backstop rather than the norm.
 */
export async function shrink(file: File, maxEdge: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? file), "image/jpeg", 0.72));
}

/** A blob as the data: URL the extraction routes accept. */
export function asDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(blob);
  });
}
