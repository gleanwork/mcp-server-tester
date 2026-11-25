/**
 * The MST mark: a check between square brackets (assets/brand/). This is the small drawing from
 * favicon.svg, aligned to a 16-unit pixel grid, which the brand guide uses at 24px and below.
 * The brackets follow the text color; the check is Glean blue, lighter in dark mode for contrast.
 */
export function Logo({
  className = '',
  size = 24,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      fill="none"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path
        className="stroke-[#11141A] dark:stroke-white"
        strokeLinecap="square"
        strokeLinejoin="miter"
        d="M4 2H2v12h2M12 2h2v12h-2"
      />
      <path
        className="stroke-[#343CED] dark:stroke-[#7C83FF]"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5 8.5l2 2 4-4.5"
      />
    </svg>
  );
}
