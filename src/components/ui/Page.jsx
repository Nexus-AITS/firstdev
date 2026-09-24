import { motion } from "framer-motion";

/**
 * Page-level wrapper — fades each route in/out under AnimatePresence and
 * provides the skip-link target.
 */
export default function Page({ children, className = "" }) {
  return (
    <motion.main
      id="main-content"
      className={`relative ${className}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: 0.5, ease: "easeOut" } }}
      // Short exit: mode="wait" blocks the next route until this finishes,
      // so 0.5s felt like a dead beat between pages (and sat under the
      // transition veils anyway). 0.32s keeps the fade, cuts the wait.
      exit={{ opacity: 0, transition: { duration: 0.32, ease: "easeIn" } }}
    >
      {children}
    </motion.main>
  );
}
