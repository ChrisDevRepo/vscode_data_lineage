"use client";

import { AuiIf, ThreadPrimitive, useAui } from "@assistant-ui/react";
import { useCallback, useEffect, useRef, useState, type FC } from "react";
import { useChatContext } from "../../../../ChatContext";

const FollowupSuggestionsRow: FC = () => {
  const { state: { followups }, actions } = useChatContext();
  const aui = useAui();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rtlRef = useRef<boolean | null>(null);
  const [fades, setFades] = useState({ left: false, right: false });

  const updateFades = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    // scrollLeft runs 0..-max in RTL; normalize to hidden width per physical edge.
    const fromStart = Math.abs(el.scrollLeft);
    // getComputedStyle forces a style recalc per scroll event; direction is stable, read it once.
    const rtl = (rtlRef.current ??= getComputedStyle(el).direction === "rtl");
    const [left, right] = rtl
      ? [maxScroll - fromStart, fromStart]
      : [fromStart, maxScroll - fromStart];
    setFades((prev) => {
      const next = { left: left > 1, right: right > 1 };
      return prev.left === next.left && prev.right === next.right ? prev : next;
    });
  }, []);

  useEffect(() => {
    updateFades();
    const el = scrollRef.current;
    if (!el?.firstElementChild) return undefined;
    const observer = new ResizeObserver(updateFades);
    observer.observe(el);
    observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [updateFades]);

  const maskImage = `linear-gradient(to right, ${
    fades.left ? "transparent, black 2rem" : "black"
  }, ${fades.right ? "black calc(100% - 2rem), transparent" : "black"})`;

  return (
    <div
      ref={scrollRef}
      onScroll={updateFades}
      // overflow-x clips both axes; py-1/-my-1 gives focus rings vertical room without changing outer height.
      className="aui-thread-followup-suggestions -my-1 w-full [scrollbar-width:none] overflow-x-auto py-1 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      style={{ maskImage, WebkitMaskImage: maskImage }}
    >
      <div className="mx-auto flex min-h-8 w-max items-center gap-2 px-0.5">
        {followups.map(({ label, prompt, offerId }) => (
          <ThreadPrimitive.Suggestion
            key={label}
            className="aui-thread-followup-suggestion border-foreground/10 hover:bg-foreground/[0.03] hover:border-foreground/25 rounded-md border px-2.5 py-1 text-sm whitespace-nowrap transition-colors ease-in motion-reduce:transition-none"
            prompt={prompt}
            send
            onClick={offerId ? (event) => {
              event.preventDefault();
              actions.followup(offerId);
              aui.composer.setText("");
            } : undefined}
          >
            {label}
          </ThreadPrimitive.Suggestion>
        ))}
      </div>
    </div>
  );
};

export const ThreadFollowupSuggestions: FC = () => {
  const { state } = useChatContext();
  if (state.followups.length === 0) return null;
  return (
    <AuiIf condition={(s) => !s.thread.isRunning}>
      <FollowupSuggestionsRow />
    </AuiIf>
  );
};
