import logoMark from "../assets/logo-mark.png";

/** The mark's own proportions, so height alone is enough to size it. */
const ASPECT = "729 / 633";

/**
 * The niko mark, painted in whatever accent is currently set.
 *
 * The source PNG is one colour on transparency, so it is used as a *mask*
 * rather than drawn as an image: the shape comes from the file's alpha
 * channel and the colour comes from a theme token. That is the whole reason
 * this is a component and not an `<img>` — an img would stay the red it was
 * exported in while the rest of the app switched to yolk.
 *
 * `color` names the token to paint with, so a caller on a dark ground can ask
 * for a lighter step of the same ramp. `decorative` is for the watermark and
 * anywhere else the mark is texture rather than the app's name: it drops out
 * of the accessibility tree instead of announcing "niko" a second time.
 */
export function LogoMark({
  className = "",
  color = "bg-brand-600",
  decorative = false,
}: {
  className?: string;
  color?: string;
  decorative?: boolean;
}) {
  return (
    <span
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": "niko" })}
      className={`inline-block ${color} ${className}`}
      style={{
        aspectRatio: ASPECT,
        WebkitMaskImage: `url(${logoMark})`,
        maskImage: `url(${logoMark})`,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskPosition: "center",
        maskPosition: "center",
      }}
    />
  );
}
