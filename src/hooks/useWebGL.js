import { useMemo } from "react";

/** Returns true when a WebGL context can be created on this device. */
export default function useWebGL() {
  return useMemo(() => {
    if (typeof window === "undefined") return false;
    try {
      const canvas = document.createElement("canvas");
      const gl =
        canvas.getContext("webgl2") ||
        canvas.getContext("webgl") ||
        canvas.getContext("experimental-webgl");
      return !!gl;
    } catch {
      return false;
    }
  }, []);
}
