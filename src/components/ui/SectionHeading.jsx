import Reveal from "./Reveal.jsx";

/**
 * Cinematic section heading: micro kicker, display title lines, hairline.
 */
export default function SectionHeading({
  kicker,
  titleLines,
  align = "center",
  size = "lg",
  className = "",
  reveal = true,
}) {
  const alignCls =
    align === "left" ? "items-start text-left" : align === "right" ? "items-end text-right" : "items-center text-center";

  const sizeCls =
    size === "xl"
      ? "text-[clamp(2.75rem,7.5vw,6.5rem)]"
      : size === "md"
        ? "text-[clamp(2rem,4.5vw,3.75rem)]"
        : "text-[clamp(2.4rem,6vw,5rem)]";

  const Wrapper = reveal ? Reveal : "div";

  return (
    <div className={`flex flex-col ${alignCls} ${className}`}>
      {kicker ? (
        <Wrapper delay={0}>
          <p className="mb-5 text-[10px] font-medium uppercase tracking-[0.5em] text-lavender/70 md:text-[11px]">
            {kicker}
          </p>
        </Wrapper>
      ) : null}

      <h2
        className={`font-display ${sizeCls} leading-[1.04] tracking-[0.08em] text-crystal`}
      >
        {titleLines.map((line, i) => (
          <Reveal key={line} delay={0.08 * i} y={40}>
            <span className="block">{line}</span>
          </Reveal>
        ))}
      </h2>

      <Wrapper delay={0.25}>
        <div className="hairline mt-8 w-40 opacity-80 md:w-56" aria-hidden />
      </Wrapper>
    </div>
  );
}
