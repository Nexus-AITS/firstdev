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
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
    >
      {children}
    </motion.main>
  );
}
