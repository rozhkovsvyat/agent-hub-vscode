import { RefObject, useCallback, useEffect, useRef, useState } from "react";

interface ElementSize {
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  isResizing: boolean;
}

interface UseElementSizeOptions {
  debounceMs?: number;
}

export const useElementSize = (
  ref: RefObject<HTMLElement>,
  debounceMs = 250,
): ElementSize => {
  const [size, setSize] = useState<ElementSize>({
    clientWidth: 0,
    clientHeight: 0,
    scrollWidth: 0,
    scrollHeight: 0,
    isResizing: false,
  });
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>();

  // Debounced update function
  const debouncedSetSize = useCallback(
    (measurements: Omit<ElementSize, "isResizing">) => {
      if (timeoutRef.current !== undefined) {
        clearTimeout(timeoutRef.current);
      }
      setSize((prev) => ({ ...prev, isResizing: true }));
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = undefined;
        setSize({
          ...measurements,
          isResizing: false,
        });
      }, debounceMs);
    },
    [debounceMs],
  );

  useEffect(() => {
    if (!ref.current) return;

    const updateSize = () => {
      const element = ref.current;
      if (!element) return;

      const measurements = {
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth,
        scrollHeight: element.scrollHeight,
      };

      debouncedSetSize(measurements);
    };

    // Create ResizeObserver instance
    const resizeObserver = new ResizeObserver(() => {
      updateSize();
    });

    // Start observing the element
    resizeObserver.observe(ref.current);

    // Initial size calculation
    updateSize();

    // Cleanup
    return () => {
      resizeObserver.disconnect();
      if (timeoutRef.current !== undefined) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = undefined;
      }
    };
  }, [ref, debouncedSetSize]);

  return size;
};
