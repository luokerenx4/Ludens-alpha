"use client";

import { useEffect, useRef, useState } from "react";
import {
  localDashboardLink,
  type ActivityDisplay,
} from "../lib/desktop";
import "./pet-settings.css";

/** Native affordances around the same Web console; no second run view. */
export function DesktopBridge({
  onNavigate,
}: {
  onNavigate(url: string): void;
}) {
  const [messages, setMessages] = useState<
    Map<string, Extract<ActivityDisplay, { type: "show" }>["input"]>
  >(() => new Map());
  const [error, setError] = useState(false);
  const navigate = useRef(onNavigate);
  useEffect(() => {
    navigate.current = onNavigate;
  }, [onNavigate]);
  useEffect(() => {
    const companion = window.ludens?.companion;
    if (!companion) return;
    const open = (input: string) => {
      const url = localDashboardLink(input, window.location.href);
      if (url) navigate.current(url);
    };
    const offDisplay = companion.activity.onDisplay((event) =>
      setMessages((previous) => {
        const next = new Map(previous);
        if (event.type === "hide") next.delete(event.displayId);
        else next.set(event.displayId, event.input);
        return next;
      }),
    );
    const offOpen = companion.activity.onOpen(open);
    return () => {
      offDisplay();
      offOpen();
    };
  }, []);
  const action = async (name: "open" | "dismiss", id: string) => {
    setError(false);
    try {
      await window.ludens?.companion?.activity[name](id);
    } catch {
      setError(true);
    }
  };
  return (
    <aside
      className="desktop-notifications"
      aria-label="活动通知"
      aria-live="polite"
    >
      {[...messages].map(([id, input]) => (
        <article
          className={`desktop-notification ${input.status === "error" ? "is-error" : ""}`}
          key={id}
        >
          <div>
            <span className="desktop-notification-label">
              LUDENS PET · {input.block?.kind ?? "活动"}
            </span>
            <button
              aria-label="关闭通知"
              onClick={() => void action("dismiss", id)}
            >
              ×
            </button>
          </div>
          <strong>{input.title}</strong>
          {input.description && <p>{input.description}</p>}
          <button
            className="control-button"
            onClick={() => void action("open", id)}
          >
            查看详情 ↗
          </button>
        </article>
      ))}
      {error && (
        <p role="alert" className="setting-error">
          无法处理通知，请重试。
        </p>
      )}
    </aside>
  );
}
