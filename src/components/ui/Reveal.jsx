import { motion, useReducedMotion } from "framer-motion";

/**
 * Scroll-reveal wrapper (transform/opacity only). Falls back to a static
 * render for users who prefer reduced motion.
 */
export default function Reveal({
  children,
  className = "",
  delay = 0,
  y = 30,
  duration = 0.9,
  as = "div",
  once = true,
}) {
  const reduced = useReducedMotion();
  const MotionTag = motion[as] ?? motion.div;

  return (
    <MotionTag
      className={className}
      initial={reduced ? false : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once, margin: "-8% 0px" }}
      transition={{ duration, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </MotionTag>
  );
}
